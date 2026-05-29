/**
 * NewAPI 同步工具 - 主应用入口
 * 版本: 4.0
 * 重构版本
 */

// ============ 模块导入 ============
import { state, saveState, loadState, modelCache } from './core/state.js';
import { EVENTS, DEFAULT_CONFIG, STORAGE_KEYS, THEME, VERSION, GITHUB_REPO } from './core/constants.js';
import { eventBus } from './core/event.js';

// UI 模块
import { $, safeAddEventListener, openModal, closeModal, closeAllModals, showLoading, showEmpty, setProgress, addLog, debounce } from './ui/dom.js';
import { notifications } from './ui/notifications.js';
import { progress } from './ui/progress.js';

// API 模块
import { testConnection, loadConfig, saveConfig, getChannels, getChannelModels, syncModels, previewOneClickUpdate, executeOneClickUpdate, getStatus } from './api.js';

// 特性模块
import * as channelsModule from './features/channels/index.js';
import * as mappingModule from './features/mapping/index.js';
import * as syncModule from './features/sync/index.js';
import * as searchModule from './features/search/index.js';
import * as oneclickModule from './features/oneclick/index.js';

// 规则模块
import { rulesManager } from './rules/index.js';

// 将模块挂载到全局
window.mappingModule = mappingModule;
window.channelsModule = channelsModule;
window.searchModule = searchModule;

// ============ 主应用类 ============
class App {
  constructor() {
    this.isInitialized = false;
    this.isConnected = false;
    this.modelCacheRefreshTimer = null;
    this.modalObserver = null;
    this.init();
  }

  /**
   * 初始化
   */
  async init() {
    try {
      this.initElements();
      await this.detectRuntimeMode();
      this.bindEvents();
      this.initModalScrollLock();
      this.loadSavedConfig();
      // 从服务端读取已保存的配置状态（令牌仅存于服务端，不回传浏览器）
      await this.loadServerConfig();
      this.initTheme();
      this.bindFeatureModules();
      this.initRulesList();  // 初始化规则列表

      this.isInitialized = true;
      console.log('✅ NewAPI 同步工具已初始化');

      // 检查更新
      this.checkUpdate();

      // 自动连接或跳转到设置
      await this.autoConnectOrRedirect();

    } catch (error) {
      console.error('❌ 初始化失败:', error);
    }
  }

  /**
   * 自动连接或跳转到设置页面
   */
  isWorkerLiteMode() {
    return state.runtimeMode === 'worker-lite';
  }

  async detectRuntimeMode() {
    try {
      const result = await getStatus();
      const mode = result?.mode || result?.data?.mode;
      if (!mode) return;
      const normalized = String(mode).trim();
      if (!normalized) return;
      state.runtimeMode = normalized;
      if (this.isWorkerLiteMode()) {
        this.applyRuntimeMode();
        notifications.info('Worker lite mode: checkpoints, one-click update, and monitor are disabled.');
      }
    } catch (error) {
      console.warn('Runtime mode detection failed:', error);
    }
  }

  applyRuntimeMode() {
    if (!this.isWorkerLiteMode()) return;
    const disabledTitle = 'Worker lite mode: feature not supported.';
    const disableButton = (btn, title = disabledTitle) => {
      if (!btn) return;
      btn.disabled = true;
      btn.title = title;
      btn.setAttribute('aria-disabled', 'true');
    };

    disableButton(this.elements.quickOneClickUpdateBtn);
    disableButton(this.elements.oneClickUpdateBtn);
    disableButton(this.elements.rollbackSyncBtn);
    disableButton(this.elements.rollbackOneClickBtn);

    disableButton($('previewOneClickUpdateBtn'));
    disableButton($('executeOneClickUpdateBtn'));
    disableButton($('cancelOneClickUpdateBtn'));

    const monitorCard = this.elements.monitorEnabled?.closest('.card');
    if (monitorCard) {
      monitorCard.style.display = 'none';
    }
  }

  /**
   * 从服务端读取已保存配置（仅返回 baseUrl/userId 等非敏感信息，不含令牌）。
   * 令牌由服务端加密保存并在请求时自动补全，浏览器无需持有。
   */
  async loadServerConfig() {
    try {
      const res = await loadConfig();
      const cfg = res && res.config;
      if (res && res.success && cfg && cfg.hasConfig) {
        state.hasServerConfig = true;
        if (this.elements.baseUrl && !this.elements.baseUrl.value && cfg.baseUrl) {
          this.elements.baseUrl.value = cfg.baseUrl;
        }
        if (this.elements.userId && (!this.elements.userId.value || this.elements.userId.value === '1') && cfg.userId) {
          this.elements.userId.value = cfg.userId;
        }
        state.config = {
          ...state.config,
          baseUrl: this.elements.baseUrl?.value || cfg.baseUrl || state.config.baseUrl,
          userId: this.elements.userId?.value || cfg.userId || state.config.userId
        };
        if (this.elements.token && !this.elements.token.value) {
          this.elements.token.placeholder = '已保存（服务器加密存储，无需重复输入）';
        }
      }
    } catch (e) {
      console.warn('加载服务端配置失败:', e);
    }
  }

  async autoConnectOrRedirect() {
    let canAutoConnect = state.hasServerConfig === true;

    // 兼容旧版本：localStorage 中可能仍残留 baseUrl（不再依赖其中的令牌）
    if (!canAutoConnect) {
      const saved = localStorage.getItem(STORAGE_KEYS.CONFIG);
      if (saved) {
        try {
          const config = JSON.parse(saved);
          if (config.baseUrl && config.token) {
            canAutoConnect = true;
          }
        } catch (e) {
          console.warn('配置解析失败:', e);
        }
      }
    }

    if (canAutoConnect) {
      console.log('🔄 检测到已保存配置，自动连接...');
      // 延迟执行，确保 DOM 完全加载
      setTimeout(() => {
        this.connectAndLoadChannels();
      }, 100);
      return;
    }

    // 没有有效配置，跳转到设置页面
    console.log('⚙️ 未检测到有效配置，跳转到系统设置...');
    this.switchPage('settings', '系统设置');
    notifications.info('请先配置 NewAPI 服务器连接信息');
  }

  /**
   * 初始化规则列表
   */
  initRulesList() {
    if (window.mappingModule && typeof window.mappingModule.renderRulesList === 'function') {
      window.mappingModule.renderRulesList();
    }
  }

  /**
   * 初始化 DOM 元素引用
   */
  initElements() {
    this.elements = {
      // 配置
      baseUrl: $('baseUrl'),
      token: $('token'),
      userId: $('userId'),
      modelCacheRefreshMinutes: $('modelCacheRefreshMinutes'),
      saveConfigBtn: $('saveConfigBtn'),
      connectAndLoadBtn: $('connectAndLoadBtn'),
      quickConnectBtn: $('quickConnectBtn'),

      // 渠道
      reloadChannelsBtn: $('reloadChannelsBtn'),
      globalSearchBtn: $('globalSearchBtn'),
      channelSearch: $('channelSearch'),
      channelsCount: $('channelsCount'),
      clearSelectionsBtn: $('clearSelectionsBtn'),

      // 同步
      startSyncBtn2: $('startSyncBtn2'),
      rollbackSyncBtn: $('rollbackSyncBtn'),
      exportMappingBtn: $('exportMappingBtn'),
      syncLogs: $('syncLogs'),

      // 快速操作
      refreshChannelsBtn: $('refreshChannelsBtn'),
      quickGlobalSearchBtn: $('quickGlobalSearchBtn'),
      quickOneClickUpdateBtn: $('quickOneClickUpdateBtn'),
      quickStartSyncBtn: $('quickStartSyncBtn'),

      // 一键更新
      oneClickUpdateBtn: $('oneClickUpdateBtn'),
      rollbackOneClickBtn: $('rollbackOneClickBtn'),

      // 主题
      themeToggle: $('themeToggle'),

      // 监控设置
      monitorEnabled: $('monitorEnabled'),
      monitorIntervalHours: $('monitorIntervalHours'),
      monitorOnlyEnabled: $('monitorOnlyEnabled'),
      webhookEnabled: $('webhookEnabled'),
      webhookUrl: $('webhookUrl'),
      webhookSecret: $('webhookSecret'),
      telegramEnabled: $('telegramEnabled'),
      telegramBotToken: $('telegramBotToken'),
      telegramChatId: $('telegramChatId'),
      saveMonitorSettingsBtn: $('saveMonitorSettingsBtn'),
      manualCheckBtn: $('manualCheckBtn'),
      testWebhookBtn: $('testWebhookBtn'),
      monitorStatusBadge: $('monitorStatusBadge'),
      monitorLastCheck: $('monitorLastCheck'),

      // 导航
      menuToggle: $('menuToggle'),
      navDashboard: $('navDashboard'),
      navChannels: $('navChannels'),
      navMapping: $('navMapping'),
      navSync: $('navSync'),
      navSettings: $('navSettings'),
      pageTitle: $('pageTitle'),

      // 渠道模型弹窗
      modelsSearchInput: $('modelsSearchInput'),
      deleteSelectedMappingsBtn: $('deleteSelectedMappingsBtn'),
      selectAllModelsBtn: $('selectAllModelsBtn'),
      clearSelectedModelsBtnModal: $('clearSelectedModelsBtnModal'),
      copySelectedModelsBtn: $('copySelectedModelsBtn'),
      refreshModelsBtn: $('refreshModelsBtn'),
      showNewAPIModelsBtn: $('showNewAPIModelsBtn'),
      refreshNewAPIModelsBtn: $('refreshNewAPIModelsBtn'),
      copyNewAPIModelsBtn: $('copyNewAPIModelsBtn')
    };
  }

  /**
   * 切换页面
   */
  switchPage(pageName, title) {
    // 隐藏所有页面
    document.querySelectorAll('.page').forEach(page => {
      page.classList.remove('active');
    });

    // 移除所有导航链接的active状态
    document.querySelectorAll('.sidebar nav a').forEach(link => {
      link.classList.remove('active');
    });

    // 显示目标页面
    const targetPage = $(`page-${pageName}`);
    if (targetPage) {
      targetPage.classList.add('active');
    }

    // 更新导航active状态
    const targetNav = $(`nav${pageName.charAt(0).toUpperCase() + pageName.slice(1)}`);
    if (targetNav) {
      targetNav.classList.add('active');
    }

    // 更新页面标题
    if (this.elements.pageTitle && title) {
      this.elements.pageTitle.textContent = title;
    }

    // 移动端自动收起侧边栏
    if (window.innerWidth <= 768) {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) sidebar.classList.remove('open');
    }

    // 根据页面类型刷新内容
    if (pageName === 'mapping' && window.mappingModule) {
      console.log('🔄 切换到映射页面，开始刷新...');
      // 刷新映射页面
      if (typeof window.mappingModule.renderSelectedModels === 'function') {
        window.mappingModule.renderSelectedModels();
        console.log('✅ 已调用 renderSelectedModels');
      }
      if (typeof window.mappingModule.renderMappingTable === 'function') {
        window.mappingModule.renderMappingTable();
        console.log('✅ 已调用 renderMappingTable');
      }
    } else if (pageName === 'channels' && window.channelsModule) {
      // 刷新渠道页面
      if (typeof window.channelsModule.updateSelectedDisplay === 'function') {
        window.channelsModule.updateSelectedDisplay();
      }
      if (typeof window.channelsModule.renderChannels === 'function') {
        window.channelsModule.renderChannels();
      }
    } else if (pageName === 'settings') {
      // 加载监控设置
      this.loadMonitorSettings();
    }
  }

  /**
   * 绑定全局事件
   */
  bindEvents() {
    // 侧边栏导航
    safeAddEventListener(this.elements.navDashboard, 'click', () => this.switchPage('dashboard', '仪表盘'));
    safeAddEventListener(this.elements.navChannels, 'click', () => this.switchPage('channels', '渠道管理'));
    safeAddEventListener(this.elements.navMapping, 'click', () => this.switchPage('mapping', '模型映射'));
    safeAddEventListener(this.elements.navSync, 'click', () => this.switchPage('sync', '同步操作'));
    safeAddEventListener(this.elements.navSettings, 'click', () => this.switchPage('settings', '系统设置'));
    safeAddEventListener(this.elements.menuToggle, 'click', () => this.toggleSidebar());

    // 配置相关
    safeAddEventListener(this.elements.saveConfigBtn, 'click', () => this.saveConfig());
    safeAddEventListener(this.elements.connectAndLoadBtn, 'click', () => this.connectAndLoadChannels(true)); // 强制刷新
    safeAddEventListener(this.elements.quickConnectBtn, 'click', () => this.connectAndLoadChannels());

    // 渠道相关 - 刷新按钮强制刷新缓存
    safeAddEventListener(this.elements.reloadChannelsBtn, 'click', () => this.connectAndLoadChannels(true));
    safeAddEventListener(this.elements.globalSearchBtn, 'click', () => searchModule.openSearchModal());
    safeAddEventListener(this.elements.channelSearch, 'input', debounce((e) => {
      channelsModule.filterChannels(e.target.value);
    }, 300));
    safeAddEventListener(this.elements.clearSelectionsBtn, 'click', () => channelsModule.clearAllSelections());

    // 渠道 tag 筛选和排序
    const channelTagFilter = $('channelTagFilter');
    const channelSortBy = $('channelSortBy');
    if (channelTagFilter) {
      channelTagFilter.addEventListener('change', (e) => {
        channelsModule.setTagFilter(e.target.value);
      });
    }
    if (channelSortBy) {
      channelSortBy.addEventListener('change', (e) => {
        channelsModule.setSortBy(e.target.value);
      });
    }

    // 快速操作按钮 - 刷新按钮强制刷新缓存
    safeAddEventListener(this.elements.refreshChannelsBtn, 'click', () => this.connectAndLoadChannels(true));
    safeAddEventListener(this.elements.quickGlobalSearchBtn, 'click', () => searchModule.openSearchModal());
    safeAddEventListener(this.elements.quickOneClickUpdateBtn, 'click', () => oneclickModule.openModal());
    safeAddEventListener(this.elements.quickStartSyncBtn, 'click', () => this.handleStartSync());

    // 同步相关
    safeAddEventListener(this.elements.startSyncBtn2, 'click', () => this.handleStartSync());
    safeAddEventListener(this.elements.rollbackSyncBtn, 'click', () => syncModule.restoreLastCheckpoint?.());
    safeAddEventListener(this.elements.exportMappingBtn, 'click', () => mappingModule.exportMappingsToFile());

    // 映射页面 - 准备完毕按钮
    const goToSyncBtn = $('goToSyncBtn');
    if (goToSyncBtn) {
      goToSyncBtn.addEventListener('click', () => {
        notifications.success('准备完成，正在跳转...');
        this.switchPage('sync', '同步操作');
      });
    }

    // 一键更新
    safeAddEventListener(this.elements.oneClickUpdateBtn, 'click', () => oneclickModule.openModal());

    // 主题切换
    safeAddEventListener(this.elements.themeToggle, 'click', () => this.toggleTheme());

    // 监控设置
    safeAddEventListener(this.elements.saveMonitorSettingsBtn, 'click', () => this.saveMonitorSettings());
    safeAddEventListener(this.elements.manualCheckBtn, 'click', () => this.runManualCheck());
    safeAddEventListener(this.elements.testWebhookBtn, 'click', () => this.testNotification('webhook'));

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllModals();
      }
    });

    // 页面导航事件监听
    window.addEventListener('navigateTo', (e) => {
      const pageName = e.detail;
      const titles = {
        dashboard: '仪表盘',
        channels: '渠道管理',
        mapping: '模型映射',
        sync: '同步操作',
        settings: '系统设置'
      };
      this.switchPage(pageName, titles[pageName] || '');
    });

    // 模态框关闭按钮
    this.bindModalCloseButtons();
  }

  /**
   * 绑定功能模块事件
   */
  bindFeatureModules() {
    // 一键更新预览按钮
    const previewBtn = $('previewOneClickUpdateBtn');
    if (previewBtn) {
      previewBtn.onclick = () => oneclickModule.previewUpdate();
    }

    // 一键更新执行按钮
    const executeBtn = $('executeOneClickUpdateBtn');
    if (executeBtn) {
      executeBtn.onclick = () => oneclickModule.executeUpdate();
    }

    // 一键更新取消按钮
    const cancelBtn = $('cancelOneClickUpdateBtn');
    if (cancelBtn) {
      cancelBtn.onclick = () => oneclickModule.cancelActiveJob?.();
    }

    const rollbackOneClickBtn = $('rollbackOneClickBtn');
    if (rollbackOneClickBtn) {
      rollbackOneClickBtn.onclick = () => oneclickModule.restoreLastCheckpoint?.();
    }

    // 一键更新映射选择按钮
    const selectAllMappingsBtn = $('selectAllMappingsBtn');
    if (selectAllMappingsBtn) {
      selectAllMappingsBtn.onclick = () => oneclickModule.selectAllMappings?.();
    }

    const deselectAllMappingsBtn = $('deselectAllMappingsBtn');
    if (deselectAllMappingsBtn) {
      deselectAllMappingsBtn.onclick = () => oneclickModule.deselectAllMappings?.();
    }

    const selectHighConfidenceBtn = $('selectHighConfidenceBtn');
    if (selectHighConfidenceBtn) {
      selectHighConfidenceBtn.onclick = () => oneclickModule.selectHighConfidenceOnly?.();
    }

    const addSelectedMappingsBtn = $('addSelectedMappingsBtn');
    if (addSelectedMappingsBtn) {
      addSelectedMappingsBtn.onclick = () => oneclickModule.addSelectedMappingsToCustom?.();
    }

    // 全局搜索
    const searchInput = $('globalSearchInput');
    const performSearchBtn = $('performGlobalSearchBtn');
    const performDeepSearchBtn = $('performDeepSearchBtn');

    if (searchInput && performSearchBtn) {
      performSearchBtn.onclick = () => searchModule.globalSearch(searchInput.value);
      searchInput.onkeypress = (e) => {
        if (e.key === 'Enter') searchModule.globalSearch(searchInput.value);
      };
    }

    if (performDeepSearchBtn && searchInput) {
      performDeepSearchBtn.onclick = () => searchModule.deepSearch(searchInput.value);
    }

    // 搜索结果操作按钮
    const selectAllGlobalResultsBtn = $('selectAllGlobalResultsBtn');
    const deselectAllGlobalResultsBtn = $('deselectAllGlobalResultsBtn');
    const applyGlobalSelectionBtn = $('applyGlobalSelectionBtn');

    if (selectAllGlobalResultsBtn) {
      selectAllGlobalResultsBtn.onclick = () => searchModule.selectAllSearchResults();
    }
    if (deselectAllGlobalResultsBtn) {
      deselectAllGlobalResultsBtn.onclick = () => searchModule.deselectAllSearchResults();
    }
    if (applyGlobalSelectionBtn) {
      applyGlobalSelectionBtn.onclick = () => searchModule.addSearchSelectionToMapping();
    }

    // 添加到映射按钮
    const addToMappingBtn = $('addToMappingBtn');
    if (addToMappingBtn) {
      addToMappingBtn.onclick = () => channelsModule.addSelectedModelsToMapping();
    }

    if (this.elements.clearSelectedModelsBtnModal) {
      this.elements.clearSelectedModelsBtnModal.onclick = () => channelsModule.clearSelectedModelsForCurrentChannel();
    }

    if (this.elements.copySelectedModelsBtn) {
      this.elements.copySelectedModelsBtn.onclick = () => channelsModule.copySelectedModelsForCurrentChannel();
    }

    if (this.elements.selectAllModelsBtn) {
      this.elements.selectAllModelsBtn.onclick = () => channelsModule.selectAllVisibleModels();
    }

    if (this.elements.refreshModelsBtn) {
      this.elements.refreshModelsBtn.onclick = () => channelsModule.refreshCurrentChannelModels();
    }

    if (this.elements.showNewAPIModelsBtn) {
      this.elements.showNewAPIModelsBtn.onclick = () => channelsModule.openNewAPIModelsModal();
    }

    if (this.elements.refreshNewAPIModelsBtn) {
      this.elements.refreshNewAPIModelsBtn.onclick = () => channelsModule.refreshNewAPIModels();
    }

    if (this.elements.copyNewAPIModelsBtn) {
      this.elements.copyNewAPIModelsBtn.onclick = () => channelsModule.copyNewAPIModels();
    }

    // 原有模型全选按钮
    const selectAllNewAPIModelsBtn = $('selectAllNewAPIModelsBtn');
    if (selectAllNewAPIModelsBtn) {
      selectAllNewAPIModelsBtn.onclick = () => channelsModule.selectAllNewAPIModels();
    }

    // 映射页面按钮
    const resetPreviewBtn = $('resetPreviewBtn');
    if (resetPreviewBtn) {
      resetPreviewBtn.onclick = () => {
        if (smartNameMatching) smartNameMatching.checked = false;
        if (autoChannelSuffix) autoChannelSuffix.checked = false;
        if (enableCustomRules) enableCustomRules.checked = false;
        updateSmartMatchControls();
        mappingModule.restoreOriginalMappings();
      };
    }

    if (this.elements.deleteSelectedMappingsBtn) {
      this.elements.deleteSelectedMappingsBtn.onclick = () => mappingModule.deleteSelectedMappingsFromTable();
    }

    const clearSelectedButtons = [
      $('clearSelectedModelsBtnChannels'),
      $('clearSelectedModelsBtnMapping')
    ];
    clearSelectedButtons.forEach(btn => {
      if (!btn) return;
      btn.onclick = () => {
        mappingModule.clearAllMappings();
        if (window.channelsModule && typeof window.channelsModule.updateSelectedDisplay === 'function') {
          window.channelsModule.updateSelectedDisplay();
        }
      };
    });

    // 规则管理按钮
    const addCustomRuleBtn = $('addCustomRuleBtn');
    if (addCustomRuleBtn) {
      addCustomRuleBtn.onclick = () => mappingModule.addCustomRule();
    }

    const saveCustomRulesBtn = $('saveCustomRulesBtn');
    if (saveCustomRulesBtn) {
      saveCustomRulesBtn.onclick = () => mappingModule.saveCustomRules();
    }

    const clearAllRulesBtn = $('clearAllRulesBtn');
    if (clearAllRulesBtn) {
      clearAllRulesBtn.onclick = () => mappingModule.clearAllRules();
    }

    // 规则模板按钮
    const openTemplatesBtn = $('openTemplatesBtn');
    if (openTemplatesBtn) {
      openTemplatesBtn.onclick = () => mappingModule.openTemplatesModal();
    }

    // 模板模态框关闭按钮
    const closeTemplateBtn = $('closeTemplateBtn');
    const closeTemplateModalBtn = $('closeTemplateModalBtn');
    if (closeTemplateBtn) closeTemplateBtn.onclick = () => closeModal('templateModal');
    if (closeTemplateModalBtn) closeTemplateModalBtn.onclick = () => closeModal('templateModal');

    // 自定义规则模态框按钮
    const testCustomRuleBtn = $('testCustomRuleBtn');
    if (testCustomRuleBtn) {
      testCustomRuleBtn.onclick = () => mappingModule.testCustomRule();
    }

    const saveCustomRuleBtn = $('saveCustomRuleBtn');
    if (saveCustomRuleBtn) {
      saveCustomRuleBtn.onclick = () => mappingModule.saveCustomRule();
    }

    const cancelCustomRuleBtn = $('cancelCustomRuleBtn');
    if (cancelCustomRuleBtn) {
      cancelCustomRuleBtn.onclick = () => closeModal('customRuleModal');
    }

    // 条件值输入框显示控制
    const customRuleCondition = $('customRuleCondition');
    const conditionValueGroup = $('conditionValueGroup');
    if (customRuleCondition && conditionValueGroup) {
      customRuleCondition.addEventListener('change', (e) => {
        conditionValueGroup.style.display = e.target.value === 'all' ? 'none' : 'block';
      });
    }

    // 映射选项 - 绑定变更事件
    const smartNameMatching = $('smartNameMatching');
    const autoChannelSuffix = $('autoChannelSuffix');
    const enableCustomRules = $('enableCustomRules');
    const smartMatchKeepDate = $('smartMatchKeepDate');
    const smartMatchKeepVersion = $('smartMatchKeepVersion');
    const smartMatchKeepNamespace = $('smartMatchKeepNamespace');
    const smartMatchFormatName = $('smartMatchFormatName');

    const updateSmartMatchControls = () => {
      const enabled = smartNameMatching ? smartNameMatching.checked : true;
      [smartMatchKeepDate, smartMatchKeepVersion, smartMatchKeepNamespace, smartMatchFormatName].forEach(el => {
        if (el) el.disabled = !enabled;
      });
    };

    updateSmartMatchControls();

    // 选项变更时自动刷新映射预览
    safeAddEventListener(smartNameMatching, 'change', () => {
      updateSmartMatchControls();
      mappingModule.updatePreviewOnOptionChange();
    });
    safeAddEventListener(autoChannelSuffix, 'change', () => mappingModule.updatePreviewOnOptionChange());
    safeAddEventListener(enableCustomRules, 'change', () => mappingModule.updatePreviewOnOptionChange());
    safeAddEventListener(smartMatchKeepDate, 'change', () => mappingModule.updatePreviewOnOptionChange());
    safeAddEventListener(smartMatchKeepVersion, 'change', () => mappingModule.updatePreviewOnOptionChange());
    safeAddEventListener(smartMatchKeepNamespace, 'change', () => mappingModule.updatePreviewOnOptionChange());
    safeAddEventListener(smartMatchFormatName, 'change', () => mappingModule.updatePreviewOnOptionChange());

    // 应用规则并刷新按钮
    const applyAllRulesBtn = $('applyAllRulesBtn');
    if (applyAllRulesBtn) {
      applyAllRulesBtn.onclick = () => {
        mappingModule.generateSmartMappings();
        notifications.success('已应用所有规则并刷新映射');
      };
    }

    // 映射搜索和过滤
    const mappingSearchInput = $('mappingSearchInput');
    if (mappingSearchInput) {
      mappingSearchInput.onkeyup = (e) => {
        if (e.key === 'Enter' || e.target.value === '') {
          mappingModule.searchMappings(e.target.value);
        }
      };
      mappingSearchInput.oninput = debounce((e) => {
        mappingModule.searchMappings(e.target.value);
      }, 300);
    }

    // 渠道模型弹窗搜索
    if (this.elements.modelsSearchInput) {
      this.elements.modelsSearchInput.oninput = debounce((e) => {
        channelsModule.renderModelsList(e.target.value || '', false);
      }, 200);
    }

    // 过滤按钮
    document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        mappingModule.filterMappings(btn.dataset.filter);
      };
    });
  }

  /**
   * 绑定模态框关闭按钮
   */
  bindModalCloseButtons() {
    const closeButtons = [
      { id: 'closeGlobalSearchModalBtn', handler: searchModule.closeSearchModal },
      { id: 'closeChannelModelsModalBtn', handler: () => closeModal('channelModelsModal') },
      { id: 'closeOneClickUpdateModalBtn', handler: oneclickModule.closeModal },
      { id: 'closeNewAPIModelsModalBtn', handler: () => closeModal('newAPIModelsModal') },
      { id: 'closeCustomRuleModalBtn', handler: () => closeModal('customRuleModal') }
    ];

    closeButtons.forEach(({ id, handler }) => {
      const btn = $(id);
      if (btn) btn.onclick = handler;
    });
  }

  // ============ 配置管理 ============

  /**
   * 加载保存的配置
   */
  loadSavedConfig() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CONFIG);
      if (saved) {
        const config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
        // 迁移：清除旧版本遗留在 localStorage 中的明文令牌
        if (Object.prototype.hasOwnProperty.call(JSON.parse(saved), 'token')) {
          const { token, ...localConfig } = config;
          localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(localConfig));
        }
        if (this.elements.baseUrl) this.elements.baseUrl.value = config.baseUrl || '';
        if (this.elements.userId) this.elements.userId.value = config.userId || '1';
        if (this.elements.modelCacheRefreshMinutes) {
          this.elements.modelCacheRefreshMinutes.value = config.modelCacheRefreshMinutes || DEFAULT_CONFIG.modelCacheRefreshMinutes;
        }
        // 令牌不再从浏览器恢复；保留旧 token 仅用于本次迁移期间的连续可用性
        state.config = config;
        this.applyModelCacheSettings(config);
      }
    } catch (error) {
      console.warn('加载配置失败:', error);
    }

    // 恢复映射数据
    this.loadSavedMappings();
  }

  /**
   * 加载保存的映射数据
   */
  loadSavedMappings() {
    try {
      const savedMappings = localStorage.getItem(STORAGE_KEYS.MODEL_MAPPINGS);
      if (savedMappings) {
        const mappings = JSON.parse(savedMappings);
        if (typeof mappings === 'object' && mappings !== null) {
          state.mappings = mappings;
          console.log('✅ 已恢复映射数据:', Object.keys(mappings).length, '个');
        }
      }

      // 恢复 modelChannelMap
      const savedChannelMap = localStorage.getItem('newapi-model-channel-map');
      if (savedChannelMap) {
        const channelMap = JSON.parse(savedChannelMap);
        if (typeof channelMap === 'object' && channelMap !== null) {
          state.modelChannelMap = channelMap;
          console.log('✅ 已恢复渠道映射数据');
        }
      }
    } catch (error) {
      console.warn('加载映射数据失败:', error);
    }
  }

  /**
   * 保存配置
   */
  async saveConfig() {
    const baseUrlEl = this.elements.baseUrl;
    const tokenEl = this.elements.token;
    const userIdEl = this.elements.userId;
    const cacheRefreshEl = this.elements.modelCacheRefreshMinutes;
    const cacheRefreshMinutes = this.normalizeCacheRefreshMinutes(cacheRefreshEl?.value);

    const config = {
      ...DEFAULT_CONFIG,
      ...(state.config || {}),
      baseUrl: (baseUrlEl && baseUrlEl.value) ? baseUrlEl.value.trim() : '',
      token: (tokenEl && tokenEl.value) ? tokenEl.value.trim() : '',
      userId: (userIdEl && userIdEl.value) ? userIdEl.value : '1',
      modelCacheRefreshMinutes: cacheRefreshMinutes
    };

    if (cacheRefreshEl) {
      cacheRefreshEl.value = config.modelCacheRefreshMinutes;
    }

    const hasToken = !!config.token;

    if (!config.baseUrl || !config.userId) {
      notifications.error('请填写完整的配置信息');
      return { success: false, message: '配置不完整' };
    }
    // 服务端已保存令牌时允许留空（沿用已存令牌）；否则首次配置必须填写
    if (!hasToken && !state.hasServerConfig) {
      notifications.error('请填写访问令牌');
      return { success: false, message: '缺少访问令牌' };
    }

    try {
      // 仅在浏览器本地保存非敏感字段，访问令牌绝不写入 localStorage
      const { token, ...localConfig } = config;
      localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(localConfig));

      // 仅当用户输入了新令牌时才提交到服务器（服务端 AES 加密存储）
      if (hasToken) {
        const result = await saveConfig(config);
        if (!result.success) {
          notifications.error(`保存失败: ${result.message}`);
          return { success: false, message: result.message };
        }
        state.hasServerConfig = true;
      }

      state.config = config;
      this.applyModelCacheSettings(config);
      if (hasToken) {
        notifications.success('配置已保存');
      }
      return { success: true };
    } catch (error) {
      notifications.error(`保存失败: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  normalizeCacheRefreshMinutes(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONFIG.modelCacheRefreshMinutes;
    return Math.round(parsed);
  }

  applyModelCacheSettings(config = {}) {
    const minutes = this.normalizeCacheRefreshMinutes(config.modelCacheRefreshMinutes);
    modelCache.setMaxAge(minutes * 60 * 1000);
    if (this.isConnected) {
      this.startModelCacheAutoRefresh(minutes);
    }
  }

  startModelCacheAutoRefresh(minutes) {
    const intervalMs = this.normalizeCacheRefreshMinutes(minutes) * 60 * 1000;
    this.stopModelCacheAutoRefresh();

    this.modelCacheRefreshTimer = setInterval(() => {
      if (!this.isConnected || !Array.isArray(state.channels) || state.channels.length === 0) return;
      channelsModule.prefetchAllChannelModels({ forceRefresh: true, preserveCache: true })
        .catch((error) => {
          console.warn('后台更新模型缓存失败:', error);
        });
    }, intervalMs);
  }

  stopModelCacheAutoRefresh() {
    if (this.modelCacheRefreshTimer) {
      clearInterval(this.modelCacheRefreshTimer);
      this.modelCacheRefreshTimer = null;
    }
  }

  initModalScrollLock() {
    const update = () => {
      const hasModal = document.querySelector('.modal.show, .modal.active');
      document.body.classList.toggle('modal-open', Boolean(hasModal));
    };

    update();
    this.modalObserver = new MutationObserver(update);
    document.querySelectorAll('.modal').forEach(modal => {
      this.modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // ============ 连接管理 ============

  /**
   * 显示顶部进度条（非阻塞）
   */
  showTopProgress() {
    const bar = $('topProgressBar');
    const fill = $('topProgressFill');
    if (bar) {
      bar.classList.remove('hidden');
      if (fill) fill.style.width = '0%';
    }
    if (this.topProgressHideTimer) {
      clearTimeout(this.topProgressHideTimer);
      this.topProgressHideTimer = null;
    }
  }

  /**
   * 更新顶部进度条
   */
  updateTopProgress(percent) {
    const fill = $('topProgressFill');
    if (fill) fill.style.width = `${percent}%`;
  }

  /**
   * 隐藏顶部进度条
   */
  hideTopProgress() {
    const bar = $('topProgressBar');
    const fill = $('topProgressFill');
    if (fill) fill.style.width = '100%';
    if (this.topProgressHideTimer) {
      clearTimeout(this.topProgressHideTimer);
    }
    this.topProgressHideTimer = setTimeout(() => {
      if (bar) bar.classList.add('hidden');
      this.topProgressHideTimer = null;
    }, 300);
  }

  /**
   * 显示模型缓存进度条
   */
  showModelCacheProgress() {
    const bar = $('modelCacheProgressBar');
    const fill = $('modelCacheProgressFill');
    if (bar) {
      bar.classList.remove('hidden');
      if (fill) fill.style.width = '0%';
    }
  }

  /**
   * 更新模型缓存进度条
   */
  updateModelCacheProgress(percent) {
    const fill = $('modelCacheProgressFill');
    if (fill) fill.style.width = `${percent}%`;
  }

  /**
   * 隐藏模型缓存进度条
   */
  hideModelCacheProgress() {
    const bar = $('modelCacheProgressBar');
    const fill = $('modelCacheProgressFill');
    if (fill) fill.style.width = '100%';
    if (this.modelCacheProgressHideTimer) {
      clearTimeout(this.modelCacheProgressHideTimer);
    }
    this.modelCacheProgressHideTimer = setTimeout(() => {
      if (bar) bar.classList.add('hidden');
      this.modelCacheProgressHideTimer = null;
    }, 300);
  }

  /**
   * 显示内联加载指示器
   */
  showInlineLoading(text = '加载中...') {
    const container = $('inlineLoadingContainer');
    if (container) {
      if (this.inlineLoadingHideTimer) {
        clearTimeout(this.inlineLoadingHideTimer);
        this.inlineLoadingHideTimer = null;
      }
      container.innerHTML = `
        <div class="inline-loading">
          <div class="spinner"></div>
          <span>${text}</span>
        </div>
      `;
    }
  }

  /**
   * 更新内联加载状态
   */
  updateInlineLoading(text, status = '') {
    const container = $('inlineLoadingContainer');
    if (container) {
      const loading = container.querySelector('.inline-loading');
      if (loading) {
        loading.className = `inline-loading ${status}`;
        const span = loading.querySelector('span');
        if (span) span.textContent = text;
        const spinner = loading.querySelector('.spinner');
        if (spinner && status) {
          spinner.innerHTML = status === 'success' ? '<i class="fas fa-check"></i>' : '<i class="fas fa-times"></i>';
          spinner.style.animation = 'none';
          spinner.style.border = 'none';
        }
      }
    }
  }

  /**
   * 隐藏内联加载指示器
   */
  hideInlineLoading(delay = 2000) {
    if (this.inlineLoadingHideTimer) {
      clearTimeout(this.inlineLoadingHideTimer);
    }
    this.inlineLoadingHideTimer = setTimeout(() => {
      const container = $('inlineLoadingContainer');
      if (container) container.innerHTML = '';
      this.inlineLoadingHideTimer = null;
    }, delay);
  }

  /**
   * 显示全局加载遮罩（仅首次加载使用）
   */
  showGlobalLoading(text = '正在加载...', detail = '') {
    const overlay = $('globalLoadingOverlay');
    const textEl = $('globalLoadingText');
    const detailEl = $('globalLoadingDetail');
    const progressEl = $('globalLoadingProgress');

    if (overlay) {
      overlay.style.display = 'flex';
      if (textEl) textEl.textContent = text;
      if (detailEl) detailEl.textContent = detail;
      if (progressEl) progressEl.style.width = '0%';
    }
  }

  /**
   * 更新全局加载进度
   */
  updateGlobalLoading(text, progress, detail = '') {
    const textEl = $('globalLoadingText');
    const detailEl = $('globalLoadingDetail');
    const progressEl = $('globalLoadingProgress');

    if (textEl) textEl.textContent = text;
    if (detailEl) detailEl.textContent = detail;
    if (progressEl) progressEl.style.width = `${progress}%`;
  }

  /**
   * 隐藏全局加载遮罩
   */
  hideGlobalLoading() {
    const overlay = $('globalLoadingOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  /**
   * 连接并加载渠道（支持缓存和非阻塞加载）
   */
  async connectAndLoadChannels(forceRefresh = false) {
    // 先保存配置
    const saveResult = await this.saveConfig();
    if (!saveResult.success) {
      return;
    }

    // 统一使用非阻塞加载
    this.showTopProgress();
    this.showInlineLoading('连接中...');

    progress.start('progressFill', 'progressText', '正在连接...');
    addLog('syncLogs', '🔄 正在连接服务器...');

    try {
      // 测试连接
      const testResult = await testConnection();
      if (testResult.success) {
        this.updateTopProgress(30);
        this.showInlineLoading('获取渠道...');
        progress.update('progressFill', 'progressText', 30, '连接成功，加载渠道...');
        addLog('syncLogs', '✅ 连接成功');

        // 加载渠道（支持缓存）
        const channelsResult = await channelsModule.loadChannels(forceRefresh);
        if (channelsResult.success) {
          const totalChannels = state.channels.length;
          const fromCache = channelsResult.fromCache;

          this.updateTopProgress(70);
          this.showInlineLoading('渲染中...');
          progress.update('progressFill', 'progressText', 70, '正在渲染...');

          // 渐进式渲染渠道（分批）
          await this.progressiveRenderChannels();

          // 更新统计
          const stats = channelsModule.getChannelStats();
          this.updateStatsDisplay(stats);

          // 迁移旧格式的映射数据（在渠道加载完成后调用）
          import('./core/state.js').then(({ migrateMappingsAfterChannelsLoad }) => {
            migrateMappingsAfterChannelsLoad();
            // 重新渲染映射页面以显示迁移后的数据
            if (window.mappingModule && typeof window.mappingModule.renderSelectedModels === 'function') {
              window.mappingModule.renderSelectedModels();
            }
            if (window.mappingModule && typeof window.mappingModule.renderMappingTable === 'function') {
              window.mappingModule.renderMappingTable();
            }
          });

          this.updateTopProgress(100);
          progress.complete('progressFill', 'progressText', '加载完成!');

          const cacheHint = fromCache ? ' (缓存)' : '';
          addLog('syncLogs', `✅ 加载完成: ${stats.total} 个渠道${cacheHint}`);

          // 完成后的处理
          this.hideTopProgress();
          this.updateInlineLoading(`${stats.total} 个渠道${cacheHint}`, 'success');
          this.hideInlineLoading(2000);

          // 更新连接状态显示
          this.updateConnectionStatus(true, stats);

          // 后台预加载渠道模型缓存
          addLog('syncLogs', '⏳ 开始后台预加载渠道模型...');
          this.showModelCacheProgress();
          this.showInlineLoading('模型缓存准备中...');
          let lastCachePercent = -1;
          let lastCacheText = '';
          channelsModule.prefetchAllChannelModels({
            forceRefresh,
            onProgress: ({ completed, total }) => {
              const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
              if (percent !== lastCachePercent) {
                this.updateModelCacheProgress(percent);
                lastCachePercent = percent;
              }
              const text = total > 0 ? `模型缓存: ${completed}/${total}` : '模型缓存进行中...';
              if (text !== lastCacheText) {
                this.updateInlineLoading(text);
                lastCacheText = text;
              }
            }
          })
            .then((summary) => {
              if (!summary || !summary.success) {
                const message = summary?.message ? `后台预加载失败: ${summary.message}` : '后台预加载失败';
                addLog('syncLogs', message, 'warning');
                this.updateInlineLoading(message, 'error');
                return;
              }
              addLog(
                'syncLogs',
                `✅ 后台预加载完成: 成功 ${summary.successCount}, 失败 ${summary.failedCount}, 跳过 ${summary.skippedCount}`
              );
              this.updateInlineLoading('模型缓存完成', 'success');
              // 重新渲染渠道列表以显示失败状态
              if (summary.failedCount > 0) {
                channelsModule.renderChannels();
              }
            })
            .catch((error) => {
              this.updateInlineLoading(`模型缓存异常: ${error.message}`, 'error');
              addLog('syncLogs', `后台预加载异常: ${error.message}`, 'warning');
            })
            .finally(() => {
              this.hideModelCacheProgress();
              this.hideInlineLoading(2000);
            });
        } else {
          this.handleLoadError(channelsResult.message);
        }
      } else {
        this.handleLoadError(testResult.message);
      }
    } catch (error) {
      this.handleLoadError(error.message);
    }
  }

  /**
   * 处理加载错误
   */
  handleLoadError(message) {
    this.hideTopProgress();
    this.updateInlineLoading(`失败: ${message}`, 'error');
    this.hideInlineLoading(3000);
    progress.fail('progressFill', 'progressText', '加载失败');
    addLog('syncLogs', `❌ 加载失败: ${message}`, 'error');
    notifications.error(`加载失败: ${message}`);

    // 更新连接状态为失败
    this.updateConnectionStatus(false);
  }

  /**
   * 更新连接状态显示
   */
  updateConnectionStatus(connected, stats = null) {
    this.isConnected = connected;
    if (!connected) {
      this.stopModelCacheAutoRefresh();
    }

    // 更新侧边栏状态
    const sidebarStatus = $('sidebarStatus');
    if (sidebarStatus) {
      const dot = sidebarStatus.querySelector('.status-dot');
      const text = sidebarStatus.querySelector('span');
      if (dot) {
        dot.classList.remove('online', 'offline');
        dot.classList.add(connected ? 'online' : 'offline');
      }
      if (text) {
        text.textContent = connected ? '已连接' : '未连接';
      }
    }

    // 更新仪表盘连接状态
    const connectionStatus = $('connectionStatus');
    if (connectionStatus) {
      if (connected && stats) {
        const config = state.config || {};
        const serverUrl = config.baseUrl || '未知';
        connectionStatus.innerHTML = `
          <div class="connection-info-grid">
            <div class="connection-item">
              <span class="connection-label">服务器</span>
              <span class="connection-value">${serverUrl}</span>
            </div>
            <div class="connection-item">
              <span class="connection-label">状态</span>
              <span class="connection-value status-online">已连接</span>
            </div>
            <div class="connection-item">
              <span class="connection-label">渠道数</span>
              <span class="connection-value">${stats.total || 0}</span>
            </div>
            <div class="connection-item">
              <span class="connection-label">活跃渠道</span>
              <span class="connection-value">${stats.active || 0}</span>
            </div>
          </div>
        `;
      } else {
        connectionStatus.innerHTML = `<p class="text-muted">连接失败，请检查配置</p>`;
      }
    }

    if (connected) {
      this.startModelCacheAutoRefresh(state.config?.modelCacheRefreshMinutes || DEFAULT_CONFIG.modelCacheRefreshMinutes);
    }
  }

  /**
   * 渐进式渲染渠道
   */
  async progressiveRenderChannels() {
    const grid = $('channelsGrid');
    if (!grid) {
      channelsModule.renderChannels();
      return;
    }

    const channels = state.channels;
    const batchSize = 20; // 每批渲染 20 个
    const totalBatches = Math.ceil(channels.length / batchSize);

    // 先清空并显示骨架屏
    grid.innerHTML = Array(Math.min(6, channels.length))
      .fill('<div class="skeleton skeleton-card"></div>')
      .join('');

    // 短暂延迟让骨架屏显示
    await new Promise(resolve => setTimeout(resolve, 50));

    // 分批渲染
    for (let i = 0; i < totalBatches; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, channels.length);
      const progress = Math.round(70 + (i / totalBatches) * 25);

      this.updateGlobalLoading('正在渲染界面', progress, `渲染中 ${end}/${channels.length}`);

      // 使用 requestAnimationFrame 优化渲染
      await new Promise(resolve => {
        requestAnimationFrame(() => {
          if (i === 0) {
            // 第一批：完整渲染
            channelsModule.renderChannels();
          }
          resolve();
        });
      });

      // 第一批后直接完成
      if (i === 0) break;
    }

    if (typeof channelsModule.updateSelectedDisplay === 'function') {
      channelsModule.updateSelectedDisplay();
    }
  }

  /**
   * 更新统计显示
   */
  updateStatsDisplay(stats) {
    const totalEl = $('totalChannels');
    const activeEl = $('activeChannels');
    const modelsEl = $('totalModels');
    const mappingsEl = $('uniqueModels');

    if (totalEl) totalEl.textContent = stats.total;
    if (activeEl) activeEl.textContent = stats.active;
    if (modelsEl) modelsEl.textContent = (state.channelModels && state.channelModels.length) ? state.channelModels.length : 0;
    if (mappingsEl) mappingsEl.textContent = Object.keys(state.mappings).length;
  }

  // ============ 同步管理 ============

  /**
   * 开始同步
   */
  async handleStartSync() {
    // 确保映射已生成
    if (Object.keys(state.mappings).length === 0) {
      // 自动生成映射
      mappingModule.generateSmartMappings();
    }

    const modeEl = document.querySelector('input[name="modelUpdateMode"]:checked');
    const mode = (modeEl && modeEl.value) ? modeEl.value : 'append';
    await syncModule.startSync(mode);
  }

  /**
   * 切换侧边栏（移动端）
   */
  toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('open');
  }

  // ============ 主题管理 ============

  /**
   * 检查更新
   */
  async checkUpdate() {
    try {
      const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
      if (!resp.ok) return;
      const data = await resp.json();
      const latest = data.tag_name?.replace(/^v/, '');
      if (latest && latest !== VERSION) {
        const badge = document.getElementById('updateBadge');
        if (badge) {
          badge.classList.remove('hidden');
          badge.title = `新版本 v${latest} 可用，点击查看`;
        }
      }
    } catch (e) {
      console.warn('检查更新失败:', e);
    }
  }

  /**
   * 初始化主题
   */
  initTheme() {
    const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || THEME.LIGHT;
    document.documentElement.setAttribute('data-theme', savedTheme);
    state.theme = savedTheme;
    this.updateThemeIcon(savedTheme);
  }

  /**
   * 切换主题
   */
  toggleTheme() {
    const newTheme = state.theme === THEME.LIGHT ? THEME.DARK : THEME.LIGHT;
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem(STORAGE_KEYS.THEME, newTheme);
    state.theme = newTheme;
    this.updateThemeIcon(newTheme);
    notifications.success(`已切换到${newTheme === THEME.DARK ? '深色' : '浅色'}主题`);
  }

  /**
   * 更新主题图标
   */
  updateThemeIcon(theme) {
    const themeToggle = this.elements.themeToggle;
    if (!themeToggle) return;

    const sunIcon = themeToggle.querySelector('.fa-sun');
    const moonIcon = themeToggle.querySelector('.fa-moon');
    if (sunIcon && moonIcon) {
      sunIcon.style.display = theme === THEME.DARK ? 'none' : 'inline';
      moonIcon.style.display = theme === THEME.DARK ? 'inline' : 'none';
    }
  }

  // ============ 监控管理 ============

  /**
   * 加载监控设置
   */
  async loadMonitorSettings() {
    if (this.isWorkerLiteMode()) {
      return;
    }

    try {
      const response = await fetch('/api/monitor/settings');
      const result = await response.json();
      if (result.success && result.data) {
        const settings = result.data;
        if (this.elements.monitorEnabled) this.elements.monitorEnabled.checked = settings.enabled;
        if (this.elements.monitorIntervalHours) this.elements.monitorIntervalHours.value = settings.intervalHours || 6;
        if (this.elements.monitorOnlyEnabled) this.elements.monitorOnlyEnabled.checked = settings.onlyEnabledChannels !== false;
        if (this.elements.webhookEnabled) this.elements.webhookEnabled.checked = settings.notifications?.webhook?.enabled;
        if (this.elements.webhookUrl) this.elements.webhookUrl.value = settings.notifications?.webhook?.url || '';
        if (this.elements.webhookSecret) this.elements.webhookSecret.value = settings.notifications?.webhook?.secret || '';
        if (this.elements.telegramEnabled) this.elements.telegramEnabled.checked = settings.notifications?.telegram?.enabled;
        if (this.elements.telegramBotToken) this.elements.telegramBotToken.value = settings.notifications?.telegram?.botToken || '';
        if (this.elements.telegramChatId) this.elements.telegramChatId.value = settings.notifications?.telegram?.chatId || '';
      }
      await this.loadMonitorStatus();
    } catch (error) {
      console.warn('加载监控设置失败:', error);
    }
  }

  /**
   * 加载监控状态
   */
  async loadMonitorStatus() {
    try {
      const response = await fetch('/api/monitor/status');
      const result = await response.json();
      if (result.success && result.data) {
        const status = result.data;
        const badge = this.elements.monitorStatusBadge;
        const lastCheck = this.elements.monitorLastCheck;

        if (badge) {
          if (status.enabled) {
            badge.textContent = status.isRunning ? '检测中' : '已启用';
            badge.className = 'badge ' + (status.isRunning ? 'badge-warning' : 'badge-success');
          } else {
            badge.textContent = '未启用';
            badge.className = 'badge badge-secondary';
          }
        }

        if (lastCheck) {
          if (status.lastCheckTime) {
            const time = new Date(status.lastCheckTime).toLocaleString('zh-CN');
            const lastResult = status.lastCheckResult;
            if (lastResult) {
              lastCheck.innerHTML = `上次检测: ${time}<br>扫描 ${lastResult.scannedChannels} 个渠道，发现 ${lastResult.brokenMappings} 个失效映射`;
            } else {
              lastCheck.textContent = `上次检测: ${time}`;
            }
          } else {
            lastCheck.textContent = '尚未执行检测';
          }
        }
      }
    } catch (error) {
      console.warn('加载监控状态失败:', error);
    }
  }

  /**
   * 保存监控设置
   */
  async saveMonitorSettings() {
    if (this.isWorkerLiteMode()) {
      notifications.warning('Worker lite mode: monitor is not supported.');
      return;
    }

    const settings = {
      enabled: this.elements.monitorEnabled?.checked || false,
      intervalHours: parseInt(this.elements.monitorIntervalHours?.value) || 6,
      onlyEnabledChannels: this.elements.monitorOnlyEnabled?.checked !== false,
      notifications: {
        webhook: {
          enabled: this.elements.webhookEnabled?.checked || false,
          url: this.elements.webhookUrl?.value || '',
          secret: this.elements.webhookSecret?.value || ''
        },
        telegram: {
          enabled: this.elements.telegramEnabled?.checked || false,
          botToken: this.elements.telegramBotToken?.value || '',
          chatId: this.elements.telegramChatId?.value || ''
        }
      }
    };

    try {
      const response = await fetch('/api/monitor/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const result = await response.json();
      if (result.success) {
        notifications.success('监控设置已保存');
        await this.loadMonitorStatus();
      } else {
        notifications.error(`保存失败: ${result.message}`);
      }
    } catch (error) {
      notifications.error(`保存失败: ${error.message}`);
    }
  }

  /**
   * 手动触发检测
   */
  async runManualCheck() {
    if (this.isWorkerLiteMode()) {
      notifications.warning('Worker lite mode: monitor is not supported.');
      return;
    }

    const btn = this.elements.manualCheckBtn;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 检测中...';
    }

    try {
      notifications.info('正在执行检测，请稍候...');
      const response = await fetch('/api/monitor/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      if (result.success && result.data) {
        const data = result.data;
        const brokenCount = data.brokenMappings?.length || 0;
        const fixableCount = data.newMappings?.filter(m => m.actualName)?.length || 0;
        if (brokenCount > 0) {
          notifications.warning(`检测完成: 发现 ${brokenCount} 个失效映射，${fixableCount} 个可修复`);
        } else {
          notifications.success('检测完成: 未发现失效映射');
        }
        await this.loadMonitorStatus();
      } else {
        notifications.error(`检测失败: ${result.message}`);
      }
    } catch (error) {
      notifications.error(`检测失败: ${error.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-search"></i> 立即检测';
      }
    }
  }

  /**
   * 测试通知
   */
  async testNotification(type) {
    if (this.isWorkerLiteMode()) {
      notifications.warning('Worker lite mode: monitor is not supported.');
      return;
    }

    const btn = type === 'webhook' ? this.elements.testWebhookBtn : this.elements.testTelegramBtn;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 发送中...';
    }

    try {
      const response = await fetch('/api/monitor/test-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
      });
      const result = await response.json();
      if (result.success) {
        notifications.success(`${type === 'webhook' ? 'Webhook' : 'Telegram'} 测试通知已发送`);
      } else {
        const detail = result.error ? `${result.message}: ${result.error}` : result.message;
        notifications.error(`发送失败: ${detail || '未知错误'}`);
      }
    } catch (error) {
      notifications.error(`发送失败: ${error.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = type === 'webhook'
          ? '<i class="fas fa-bell"></i> 测试 Webhook'
          : '<i class="fab fa-telegram"></i> 测试 Telegram';
      }
    }
  }
}

// ============ 应用启动 ============
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});

export default App;

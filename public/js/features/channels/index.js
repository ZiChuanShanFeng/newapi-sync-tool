/**
 * 渠道管理模块
 */
import { state, modelCache, setOps } from '../../core/state.js';
import { STORAGE_KEYS } from '../../core/constants.js';
import { getChannels, getChannelModels } from '../../api/channels.js';
import { $, copyToClipboard } from '../../ui/dom.js';
import { notifications } from '../../ui/notifications.js';

let currentOriginalModels = [];
let currentOriginalMapping = new Map();
let isModelsListReadonly = false;
let currentTagFilter = '';
let currentSortBy = 'id-desc';
const MODEL_PREFETCH_CONCURRENCY = 10;
let prefetchPromise = null;
const modelGroupCollapseState = new Map();
const failedChannels = new Set(); // 记录获取模型失败的渠道
const fallbackChannels = new Set(JSON.parse(localStorage.getItem('newapi-fallback-channels') || '[]')); // 记录回退到选中模型的渠道（这些渠道无法获取完整API模型列表）

const persistFallbackChannels = () => {
  localStorage.setItem('newapi-fallback-channels', JSON.stringify([...fallbackChannels]));
};

const CHANNEL_TYPE_LABELS = new Map([
  [1, 'OpenAI'],
  [2, 'Midjourney Proxy'],
  [3, 'Azure OpenAI'],
  [4, 'Ollama'],
  [5, 'Midjourney Proxy Plus'],
  [8, '自定义渠道'],
  [11, 'Google PaLM2'],
  [14, 'Anthropic Claude'],
  [15, '百度文心千帆'],
  [16, '智谱 ChatGLM（已废弃，请使用智谱 GLM-4V）'],
  [17, '阿里通义千问'],
  [18, '讯飞星火认知'],
  [19, '360 智脑'],
  [20, 'OpenRouter'],
  [21, '知识库：AI Proxy'],
  [22, '知识库：FastGPT'],
  [23, '腾讯混元'],
  [24, 'Google Gemini'],
  [25, 'Moonshot'],
  [26, '智谱 GLM-4V'],
  [27, 'Perplexity'],
  [31, '零一万物'],
  [33, 'AWS Claude'],
  [34, 'Cohere'],
  [35, 'MiniMax'],
  [36, 'Suno API'],
  [37, 'Dify'],
  [38, 'Jina'],
  [39, 'Cloudflare'],
  [40, 'SiliconCloud'],
  [41, 'Vertex AI'],
  [42, 'Mistral AI'],
  [43, 'DeepSeek'],
  [44, '嵌入模型：MokaAI M3E'],
  [45, '字节火山方舟、豆包通用'],
  [46, '百度文心千帆V2'],
  [47, 'Xinference'],
  [48, 'xAI'],
  [49, 'Coze'],
  [50, '可灵'],
  [51, '即梦'],
  [52, 'Vidu'],
  [53, 'SubModel'],
  [54, '豆包视频'],
  [55, 'Sora'],
  [56, 'Replicate']
]);

const formatChannelType = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && CHANNEL_TYPE_LABELS.has(numeric)) {
    return CHANNEL_TYPE_LABELS.get(numeric);
  }
  return CHANNEL_TYPE_LABELS.get(value) || String(value);
};

const MODEL_TYPE_GROUPS = [
  {
    key: 'openai',
    label: 'OpenAI',
    match: (name) => name.includes('gpt') ||
      name.includes('dall-e') ||
      name.includes('whisper') ||
      name.includes('tts-1') ||
      name.includes('text-embedding-3') ||
      name.includes('text-moderation') ||
      name.includes('babbage') ||
      name.includes('davinci') ||
      name.includes('curie') ||
      name.includes('ada') ||
      name.includes('o1') ||
      name.includes('o3') ||
      name.includes('o4')
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    match: (name) => name.includes('claude')
  },
  {
    key: 'gemini',
    label: 'Gemini',
    match: (name) => name.includes('gemini') ||
      name.includes('gemma') ||
      name.includes('learnlm') ||
      name.startsWith('embedding-') ||
      name.includes('text-embedding-004') ||
      name.includes('imagen-4') ||
      name.includes('veo-') ||
      name.includes('aqa')
  },
  {
    key: 'moonshot',
    label: 'Moonshot',
    match: (name) => name.includes('moonshot') || name.includes('kimi')
  },
  {
    key: 'zhipu',
    label: '智谱',
    match: (name) => name.includes('chatglm') ||
      name.includes('glm-') ||
      name.includes('cogview') ||
      name.includes('cogvideo')
  },
  {
    key: 'qwen',
    label: '通义千问',
    match: (name) => name.includes('qwen')
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    match: (name) => name.includes('deepseek')
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    match: (name) => name.includes('abab') || name.includes('minimax')
  },
  {
    key: 'baidu',
    label: '文心一言',
    match: (name) => name.includes('ernie')
  },
  {
    key: 'xunfei',
    label: '讯飞星火',
    match: (name) => name.includes('spark')
  },
  {
    key: 'midjourney',
    label: 'Midjourney',
    match: (name) => name.includes('mj_')
  },
  {
    key: 'tencent',
    label: '腾讯混元',
    match: (name) => name.includes('hunyuan')
  },
  {
    key: 'cohere',
    label: 'Cohere',
    match: (name) => name.includes('command') ||
      name.includes('c4ai-') ||
      name.includes('embed-')
  },
  {
    key: 'cloudflare',
    label: 'Cloudflare',
    match: (name) => name.includes('@cf/')
  },
  {
    key: 'ai360',
    label: '360智脑',
    match: (name) => name.includes('360')
  },
  {
    key: 'jina',
    label: 'Jina',
    match: (name) => name.includes('jina')
  },
  {
    key: 'mistral',
    label: 'Mistral AI',
    match: (name) => name.includes('mistral') ||
      name.includes('codestral') ||
      name.includes('pixtral') ||
      name.includes('voxtral') ||
      name.includes('magistral')
  },
  {
    key: 'xai',
    label: 'xAI',
    match: (name) => name.includes('grok')
  },
  {
    key: 'llama',
    label: 'Llama',
    match: (name) => name.includes('llama')
  },
  {
    key: 'doubao',
    label: '豆包',
    match: (name) => name.includes('doubao')
  },
  {
    key: 'yi',
    label: '零一万物',
    match: (name) => name.includes('yi')
  }
];

const groupModelsByType = (models) => {
  const groups = MODEL_TYPE_GROUPS.map(group => ({ ...group, models: [] }));
  const other = [];

  models.forEach((model) => {
    const name = model.toLowerCase();
    let matched = false;
    for (const group of groups) {
      if (group.match(name)) {
        group.models.push(model);
        matched = true;
        break;
      }
    }
    if (!matched) {
      other.push(model);
    }
  });

  const results = groups.filter(group => group.models.length > 0);
  if (other.length > 0) {
    results.push({ key: 'other', label: '其他', models: other });
  }
  return results;
};

const parseModelMapping = (value) => {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      return {};
    }
  }
  return {};
};

const buildModelMappingLookup = (mapping) => {
  const lookup = new Map();
  Object.entries(mapping || {}).forEach(([source, target]) => {
    const sourceName = String(source || '').trim();
    const targetName = String(target || '').trim();
    if (!sourceName || !targetName) return;
    lookup.set(sourceName.toLowerCase(), targetName);
  });
  return lookup;
};

const getMappedModelName = (modelName, lookup = currentOriginalMapping) => {
  if (!modelName) return '';
  if (!lookup || lookup.size === 0) return '';
  return lookup.get(modelName.toLowerCase()) || '';
};

const toModelArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(/[,;|\n]/)
      .map(item => item.trim())
      .filter(item => item.length > 0);
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.models)) return value.models;
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.list)) return value.list;
  }
  return [];
};

const normalizeModels = (value) => {
  const list = toModelArray(value);
  const normalized = list
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (typeof item === 'number') return String(item);
      if (item && typeof item === 'object') {
        const candidate = item.model ?? item.name ?? item.id ?? item.value;
        if (candidate == null) return '';
        return String(candidate).trim();
      }
      return '';
    })
    .filter(item => item && item.length > 0);

  return Array.from(new Set(normalized));
};

const extractModelsFromChannel = (channel) => {
  if (!channel) return [];
  if (channel.models != null) return normalizeModels(channel.models);
  if (channel.model != null) return normalizeModels(channel.model);
  if (channel.selected_models != null) return normalizeModels(channel.selected_models);
  return [];
};

const setChannelModelsCache = (channelId, data) => {
  const normalized = normalizeModels(data);
  modelCache.set(channelId, normalized);
  return normalized;
};

const persistMappings = () => {
  try {
    localStorage.setItem(STORAGE_KEYS.MODEL_MAPPINGS, JSON.stringify(state.mappings));
    localStorage.setItem('newapi-model-channel-map', JSON.stringify(state.modelChannelMap));
  } catch (error) {
    console.warn('保存映射缓存失败:', error);
  }
};

const fetchChannelModelsWithCache = async (channelId, options = {}) => {
  const forceRefresh = Boolean(options && options.forceRefresh);
  const preserveCache = Boolean(options && options.preserveCache);
  if (forceRefresh && !preserveCache) {
    modelCache.clearChannel(channelId);
  } else if (!forceRefresh) {
    const cached = modelCache.get(channelId);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }
  }

  try {
    const requestOptions = { ...options };
    delete requestOptions.preserveCache;
    const res = await getChannelModels(state.config, channelId, requestOptions);
    if (res && res.success) {
      const source = res.source || 'unknown';
      // 标记 fallback 来源的渠道（无法获取API模型，只能获取配置模型）
      // 一旦标记为 fallback，就永久保持这个状态
      if (source === 'fallback' || source === 'global') {
        failedChannels.add(channelId);
        fallbackChannels.add(channelId);
        persistFallbackChannels();
      }
      // 如果不是 fallback 模式且不在 fallbackChannels 中，可以清除失败标记
      else if (!fallbackChannels.has(channelId) && (source === 'fetch_models' || source === 'cache' || source === 'shared-cache')) {
        failedChannels.delete(channelId);
      }
      // source 为 'unknown' 或其他值时，不修改 failedChannels 状态（除非已在 fallbackChannels）
      return { success: true, data: setChannelModelsCache(channelId, res.data), fromCache: false, source };
    }
    failedChannels.add(channelId);
    return { success: false, data: [], message: res?.message || '获取模型失败', fromCache: false };
  } catch (error) {
    failedChannels.add(channelId);
    return { success: false, data: [], message: error.message, fromCache: false };
  }
};

/**
 * 提取所有渠道的 tag 列表
 */
const extractAllTags = () => {
  const tags = new Set();
  state.channels.forEach(channel => {
    if (channel.tag && channel.tag.trim()) {
      tags.add(channel.tag.trim());
    }
  });
  return Array.from(tags).sort();
};

/**
 * 更新 tag 筛选下拉框
 */
export const updateTagFilterOptions = () => {
  const select = $('channelTagFilter');
  if (!select) return;

  const tags = extractAllTags();
  const currentValue = select.value;

  select.innerHTML = '<option value="">全部标签</option>' +
    tags.map(tag => `<option value="${tag}"${tag === currentValue ? ' selected' : ''}>${tag}</option>`).join('');
};

/**
 * 排序渠道列表
 */
const sortChannels = (channels, sortBy) => {
  const sorted = [...channels];
  switch (sortBy) {
    case 'id-asc':
      return sorted.sort((a, b) => a.id - b.id);
    case 'id-desc':
      return sorted.sort((a, b) => b.id - a.id);
    case 'name-asc':
      return sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    case 'name-desc':
      return sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    case 'status':
      return sorted.sort((a, b) => (b.status || 0) - (a.status || 0));
    default:
      return sorted;
  }
};

/**
 * 设置 tag 筛选
 */
export const setTagFilter = (tag) => {
  currentTagFilter = tag || '';
  renderChannels();
};

/**
 * 设置排序方式
 */
export const setSortBy = (sortBy) => {
  currentSortBy = sortBy || 'id-asc';
  renderChannels();
};

const getSelectedModelsForCurrentChannel = () => {
  if (!state.currentChannelId) return [];
  return setOps.getModelsArray().filter(model => {
    const channelInfo = state.modelChannelMap[model];
    return channelInfo && String(channelInfo.id) === String(state.currentChannelId);
  });
};

const getCheckedModelCheckboxes = () => {
  const modelsList = $('modelsList');
  if (!modelsList) return [];
  return Array.from(modelsList.querySelectorAll('input[type="checkbox"]:checked'));
};

const updateAddToMappingButtonState = () => {
  const addBtn = $('addToMappingBtn');
  if (!addBtn) return;
  addBtn.disabled = getCheckedModelCheckboxes().length === 0;
};

const updateModalSelectionActions = (selectedCount) => {
  const countEl = $('modalSelectedModelsCount');
  if (countEl) countEl.textContent = `${selectedCount} 个`;

  const clearBtn = $('clearSelectedModelsBtnModal');
  if (clearBtn) clearBtn.disabled = selectedCount === 0;

  const copyBtn = $('copySelectedModelsBtn');
  if (copyBtn) copyBtn.disabled = selectedCount === 0;
};

const updateBatchSelectButtons = (disabled) => {
  const selectAllBtn = $('selectAllModelsBtn');
  const deselectAllBtn = $('deselectAllModelsBtn');
  if (selectAllBtn) selectAllBtn.disabled = disabled;
  if (deselectAllBtn) deselectAllBtn.disabled = disabled;
};

const updateModelItemSelection = (checkbox, selected) => {
  const item = checkbox.closest('.model-item');
  if (!item) return;

  checkbox.checked = selected;
  item.classList.toggle('selected', selected);

  const existingBadge = item.querySelector('.badge-selected');
  if (selected && !existingBadge) {
    const badge = document.createElement('span');
    badge.className = 'badge-selected';
    badge.textContent = '已选';
    const nameEl = item.querySelector('.model-name');
    if (nameEl) {
      nameEl.insertAdjacentElement('afterend', badge);
    } else {
      item.appendChild(badge);
    }
  } else if (!selected && existingBadge) {
    existingBadge.remove();
  }
};

const updateGroupSelectedCounts = () => {
  const modelsList = $('modelsList');
  if (!modelsList) return;
  modelsList.querySelectorAll('.models-group').forEach(groupEl => {
    const selectedCount = groupEl.querySelectorAll('.model-item.selected').length;
    const selectedEl = groupEl.querySelector('.models-group-selected');
    if (selectedEl) {
      selectedEl.textContent = `已选 ${selectedCount}`;
    }
  });
};

const getVisibleModelCheckboxes = () => {
  const modelsList = $('modelsList');
  if (!modelsList) return [];
  return Array.from(modelsList.querySelectorAll('input[type="checkbox"]'))
    .filter(cb => {
      const groupEl = cb.closest('.models-group');
      return !groupEl || !groupEl.classList.contains('collapsed');
    });
};

// 渠道列表缓存配置
const CHANNELS_CACHE_KEY = 'newapi-channels-cache';
const CHANNELS_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

/**
 * 获取渠道缓存
 */
const getChannelsCache = () => {
  try {
    const cached = localStorage.getItem(CHANNELS_CACHE_KEY);
    if (!cached) return null;

    const { data, timestamp } = JSON.parse(cached);
    const now = Date.now();

    // 检查是否过期
    if (now - timestamp > CHANNELS_CACHE_TTL) {
      localStorage.removeItem(CHANNELS_CACHE_KEY);
      return null;
    }

    return data;
  } catch (e) {
    console.warn('读取渠道缓存失败:', e);
    return null;
  }
};

/**
 * 设置渠道缓存
 */
const setChannelsCache = (data) => {
  try {
    localStorage.setItem(CHANNELS_CACHE_KEY, JSON.stringify({
      data,
      timestamp: Date.now()
    }));
  } catch (e) {
    console.warn('保存渠道缓存失败:', e);
  }
};

/**
 * 清除渠道缓存
 */
export const clearChannelsCache = () => {
  localStorage.removeItem(CHANNELS_CACHE_KEY);
};

const getCachedChannelById = (channelId) => {
  const targetId = String(channelId);
  let channel = state.channels.find(item => String(item.id) === targetId);
  if (channel) return channel;

  const cached = getChannelsCache();
  if (cached && Array.isArray(cached)) {
    channel = cached.find(item => String(item.id) === targetId);
    if (channel) {
      state.channels = cached;
      return channel;
    }
  }

  return null;
};

/**
 * 加载渠道列表（支持缓存）
 */
export const loadChannels = async (forceRefresh = false) => {
  try {
    // 如果不强制刷新，先尝试使用缓存
    if (!forceRefresh) {
      const cached = getChannelsCache();
      if (cached) {
        console.log('📦 使用渠道缓存数据');
        state.channels = cached;
        return { success: true, data: cached, fromCache: true };
      }
    }

    // 从服务器获取
    const res = await getChannels(state.config);
    if (res.success && res.data) {
      state.channels = res.data;
      // 保存到缓存
      setChannelsCache(res.data);
      console.log('🔄 已更新渠道缓存');
      return { success: true, data: res.data, fromCache: false };
    }
    return { success: false, message: res.message || '获取渠道失败' };
  } catch (error) {
    console.error('加载渠道失败:', error);
    return { success: false, message: error.message };
  }
};

/**
 * 后台预加载所有渠道模型到缓存
 */
export const prefetchAllChannelModels = async ({
  concurrency = MODEL_PREFETCH_CONCURRENCY,
  forceRefresh = false,
  preserveCache = false,
  onProgress
} = {}) => {
  if (prefetchPromise) return prefetchPromise;

  const channels = Array.isArray(state.channels) ? state.channels : [];
  if (channels.length === 0) {
    return { success: false, message: '无渠道可预加载' };
  }

  if (forceRefresh && !preserveCache) {
    modelCache.clear();
  }

  const targets = channels.filter(channel => channel && channel.id != null);
  const total = targets.length;
  let completed = 0;
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;

      const channel = targets[index];
      const channelId = channel.id;

      if (!forceRefresh && modelCache.get(channelId)) {
        skippedCount += 1;
        completed += 1;
        onProgress?.({ completed, total, successCount, failedCount, skippedCount, channelId });
        continue;
      }

      const result = await fetchChannelModelsWithCache(channelId, { forceRefresh, preserveCache });
      if (result.success) {
        successCount += 1;
      } else {
        failedCount += 1;
      }
      completed += 1;
      onProgress?.({ completed, total, successCount, failedCount, skippedCount, channelId });
    }
  };

  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), total);
  prefetchPromise = Promise.all(Array.from({ length: workerCount }, worker))
    .then(() => ({
      success: true,
      total,
      completed,
      successCount,
      failedCount,
      skippedCount
    }))
    .catch((error) => ({
      success: false,
      message: error.message,
      total,
      completed,
      successCount,
      failedCount,
      skippedCount
    }))
    .finally(() => {
      prefetchPromise = null;
    });

  return prefetchPromise;
};

/**
 * 渲染渠道卡片
 */
export const renderChannels = (filter = '') => {
  const grid = $('channelsGrid');
  if (!grid) return;

  // 应用搜索、tag 筛选和排序
  let filtered = state.channels;

  // 按搜索词筛选
  if (filter) {
    filtered = filtered.filter(c =>
      (c.name && c.name.toLowerCase().includes(filter.toLowerCase())) ||
      (c.id && String(c.id).includes(filter))
    );
  }

  // 按 tag 筛选
  if (currentTagFilter) {
    filtered = filtered.filter(c => c.tag && c.tag.trim() === currentTagFilter);
  }

  // 排序
  filtered = sortChannels(filtered, currentSortBy);

  const totalChannels = state.channels.length;
  const activeChannels = state.channels.filter(c => c.status === 1).length;

  // 更新计数
  const countEl = $('channelsCount');
  if (countEl) {
    const filterInfo = currentTagFilter ? ` (标签: ${currentTagFilter})` : '';
    countEl.textContent = `显示 ${filtered.length} / ${totalChannels} 个渠道${filterInfo}`;
  }

  // 更新 tag 筛选下拉框
  updateTagFilterOptions();

  // 更新统计
  const statsEl = $('channelsStats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="stat-item">
        <div class="stat-value">${totalChannels}</div>
        <div class="stat-label">总渠道</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${activeChannels}</div>
        <div class="stat-label">已启用</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${setOps.getModelsArray().length}</div>
        <div class="stat-label">已选模型</div>
      </div>
    `;
  }

  // 渲染网格
  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-search"></i>
        <p>没有找到匹配的渠道</p>
        ${currentTagFilter ? `<small>当前筛选标签: ${currentTagFilter}</small>` : ''}
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(channel => {
    const isFailed = failedChannels.has(channel.id);
    const isFallback = fallbackChannels.has(channel.id);
    const statusClass = channel.status !== 1 ? 'offline' : (isFallback ? 'warning' : 'online');
    const statusTitle = isFallback ? '仅获取到选中模型，无法获取完整API模型列表' : (isFailed ? '获取模型失败' : '');
    const cachedModels = modelCache.get(channel.id);
    const modelCount = cachedModels ? cachedModels.length : (channel.model_count != null ? channel.model_count : (channel.models ? channel.models.split(',').length : 0));
    return `
    <div class="channel-card ${channel.status !== 1 ? 'disabled' : ''}" data-id="${channel.id}">
      <div class="channel-header">
        <span class="channel-status ${statusClass}" ${statusTitle ? `title="${statusTitle}"` : ''}></span>
        <span class="channel-name" title="${channel.name || `渠道 ${channel.id}`}">${channel.name || `渠道 ${channel.id}`}</span>
        ${channel.tag ? `<span class="channel-tag">${channel.tag}</span>` : ''}
      </div>
      <div class="channel-meta">
        <div class="channel-info">
          <span>ID: ${channel.id}</span>
          <span>${formatChannelType(channel.type)}</span>
        </div>
        <div class="channel-models">
          <span class="models-count">
            <i class="fas fa-cube"></i>
            ${modelCount} 个模型
          </span>
        </div>
      </div>
      <div class="channel-actions">
        <button class="btn btn-sm btn-secondary view-btn" data-id="${channel.id}" data-name="${channel.name}">
          <i class="fas fa-eye"></i> 查看
        </button>
        <button class="btn btn-sm btn-primary select-btn" data-id="${channel.id}" data-name="${channel.name}">
          <i class="fas fa-plus"></i> 全选
        </button>
      </div>
    </div>
  `}).join('');

  // 绑定查看按钮事件 - 打开模型选择弹窗（选择模式）
  grid.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openChannelModelsModal(btn.dataset.id);
    });
  });

  // 绑定选择按钮事件 - 全选当前渠道所有模型
  grid.querySelectorAll('.select-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectAllModelsFromChannel(btn.dataset.id);
    });
  });
};

/**
 * 打开渠道模型弹窗（选择模式）
 */
export const openChannelModelsModal = async (channelId) => {
  const channel = state.channels.find(c => c.id == channelId);
  if (!channel) {
    notifications.error('未找到渠道信息');
    return;
  }

  state.currentChannelId = channelId;
  currentOriginalModels = [];
  currentOriginalMapping = new Map();

  // 打开弹窗
  const modal = $('channelModelsModal');
  if (modal) {
    const title = $('channelModelsTitle');
    if (title) title.textContent = `${channel.name} 的模型`;

    // 显示添加按钮（选择模式）
    const addBtn = $('addToMappingBtn');
    if (addBtn) {
      addBtn.style.display = 'inline-flex';
      addBtn.disabled = true;
    }

    // 重置搜索框
    const modelsSearchInput = $('modelsSearchInput');
    if (modelsSearchInput) modelsSearchInput.value = '';

    modal.classList.add('show');
    modal.classList.remove('active');
  }

  // 渲染当前渠道已选模型
  renderModalSelectedModels();

  // 检查缓存
  const cached = modelCache.get(channelId);
  if (cached) {
    state.channelModels = cached;
    renderModelsList('', false);  // 选择模式
    return;
  }

  // 显示加载状态
  const modelsList = $('modelsList');
  if (modelsList) {
    modelsList.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
  }

  const res = await fetchChannelModelsWithCache(channelId, { forceRefresh: true });
  if (res.success && res.data) {
    state.channelModels = res.data;
    renderModelsList('', false);  // 选择模式
  } else {
    const list = $('modelsList');
    if (list) {
      const message = res.message ? `加载失败: ${res.message}` : '暂无模型';
      list.innerHTML = `<div class="empty-state">${message}</div>`;
    }
  }
};

/**
 * 渲染模型列表
 * @param {string} filter - 搜索过滤
 * @param {boolean} readonly - 只读模式（不显示复选框）
 */
export const renderModelsList = (filter = '', readonly = false) => {
  const list = $('modelsList');
  if (!list) return;

  isModelsListReadonly = readonly;
  list.classList.add('grouped');

  const models = Array.isArray(state.channelModels) ? state.channelModels : [];
  const normalizedFilter = (filter || '').trim();
  const filtered = models.filter(m =>
    !normalizedFilter || m.toLowerCase().includes(normalizedFilter.toLowerCase())
  );

  const countEl = $('modelsCount');
  if (countEl) {
    countEl.textContent = normalizedFilter ? `${filtered.length} / ${models.length} 个` : `${models.length} 个`;
  }
  updateBatchSelectButtons(readonly || filtered.length === 0);

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">无匹配模型</div>';
    updateAddToMappingButtonState();
    return;
  }

  const expandAll = normalizedFilter.length > 0;
  const grouped = groupModelsByType(filtered);
  const currentChannelId = state.currentChannelId;
  list.innerHTML = grouped.map(group => {
    const storedCollapse = modelGroupCollapseState.get(group.key);
    const collapsed = expandAll ? false : (storedCollapse === undefined ? true : storedCollapse);
    const selectedCount = group.models.reduce((total, model) => {
      const channelInfo = state.modelChannelMap[model];
      const isSelectedForCurrentChannel = setOps.hasModel(model) && channelInfo && String(channelInfo.id) === String(currentChannelId);
      return total + (isSelectedForCurrentChannel ? 1 : 0);
    }, 0);
    const items = group.models.map(model => {
      const channelInfo = state.modelChannelMap[model];
      const isSelected = setOps.hasModel(model) && channelInfo && String(channelInfo.id) === String(currentChannelId);
      return `
        <label class="model-item ${isSelected ? 'selected' : ''}">
          ${!readonly ? `<input type="checkbox" ${isSelected ? 'checked' : ''} data-model="${model}">` : ''}
          <span class="model-name">${model}</span>
          ${isSelected ? '<span class="badge-selected">已选</span>' : ''}
        </label>
      `;
    }).join('');

    return `
      <div class="models-group${collapsed ? ' collapsed' : ''}" data-group="${group.key}">
        <button type="button" class="models-group-header" data-group-toggle aria-expanded="${collapsed ? 'false' : 'true'}">
          <span class="models-group-title">${group.label}</span>
          <span class="models-group-count">(${group.models.length})</span>
          <span class="models-group-selected">已选 ${selectedCount}</span>
          <span class="models-group-toggle" aria-hidden="true">
            <i class="fas fa-chevron-down"></i>
          </span>
        </button>
        <div class="models-group-list">
          ${items}
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-group-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const groupEl = btn.closest('.models-group');
      if (!groupEl) return;
      const groupKey = groupEl.dataset.group;
      const nextCollapsed = !groupEl.classList.contains('collapsed');
      groupEl.classList.toggle('collapsed', nextCollapsed);
      btn.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
      if (groupKey) {
        modelGroupCollapseState.set(groupKey, nextCollapsed);
      }
    });
  });

  // 绑定复选框事件
  if (!readonly) {
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const model = cb.dataset.model;
        // 获取当前渠道信息
        const channel = state.channels.find(c => c.id == state.currentChannelId);
        const channelInfo = channel ? { id: channel.id, name: channel.name } : null;
        if (e.target.checked) {
          setOps.addModel(model, channelInfo);  // 传递渠道信息
        } else {
          setOps.removeModel(model);
        }
        updateModelItemSelection(cb, e.target.checked);
        updateSelectedDisplay();
        renderModalSelectedModels();
        updateAddToMappingButtonState();
        persistMappings();
      });
    });
  }

  updateAddToMappingButtonState();
};

/**
 * 渲染模态框中已选模型列表（当前渠道）
 */
export const renderModalSelectedModels = () => {
  const list = $('modalSelectedModelsList');
  if (!list) return;

  const selectedModels = getSelectedModelsForCurrentChannel();
  updateModalSelectionActions(selectedModels.length);
  if (selectedModels.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无已选模型</div>';
    return;
  }

  list.innerHTML = selectedModels.map(model => `
    <div class="selected-model-item">
      <span class="model-name" title="${model}">${model}</span>
      <button class="btn-remove" data-model="${model}" title="移除">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSelectedModel(btn.dataset.model);
    });
  });
};

/**
 * 添加选中的模型到映射
 * @param {boolean} autoJump - 是否自动跳转到映射页面，默认true
 */
export const addSelectedModelsToMapping = (autoJump = true) => {
  const modelsList = $('modelsList');
  const checkboxes = modelsList && modelsList.querySelectorAll('input[type="checkbox"]:checked');
  const selectedCount = (checkboxes && checkboxes.length) || 0;
  console.log('🚀 开始添加选中模型到映射:', {
    选中数量: selectedCount,
    选中模型: Array.from(checkboxes || []).map(cb => cb.dataset.model)
  });

  if (!checkboxes || selectedCount === 0) {
    notifications.warning('请先选择模型');
    updateAddToMappingButtonState();
    return;
  }

  const channel = state.channels.find(c => c.id == state.currentChannelId);
  const channelInfo = channel ? { id: channel.id, name: channel.name } : null;
  let count = 0;

  checkboxes.forEach(cb => {
    const model = cb.dataset.model;
    const exists = setOps.hasModel(model);
    setOps.addModel(model, channelInfo);
    if (!state.mappings.hasOwnProperty(model)) {
      state.mappings[model] = model;
    }
    if (!state.modelChannelMap[model] && channelInfo) {
      state.modelChannelMap[model] = channelInfo;
    }
    if (!exists) {
      count++;
      console.log(`✅ 添加模型: ${model}`, { 渠道: channelInfo });
    } else {
      console.log(`⏭️ 模型已存在，跳过: ${model}`);
    }
  });

  console.log('📊 添加完成后状态:', {
    已添加: count,
    selectedModels总数: setOps.getModelsArray().length,
    selectedModels列表: setOps.getModelsArray(),
    mappings总数: Object.keys(state.mappings).length
  });

  updateSelectedDisplay();  // 更新选中模型显示
  renderModalSelectedModels();
  updateAddToMappingButtonState();
  persistMappings();

  if (count > 0) {
    notifications.success(`已选择 ${selectedCount} 个模型，新增 ${count} 个`);
  } else {
    notifications.info(`已选择 ${selectedCount} 个模型，均已在映射中`);
  }

  // 自动跳转到映射页面
  if (autoJump && window.app && typeof window.app.switchPage === 'function') {
    window.app.switchPage('mapping', '模型映射');
    // 刷新映射页面的显示
    setTimeout(() => {
      if (window.mappingModule && typeof window.mappingModule.renderSelectedModels === 'function') {
        window.mappingModule.renderSelectedModels();
      }
      if (window.mappingModule && typeof window.mappingModule.renderMappingTable === 'function') {
        window.mappingModule.renderMappingTable();
      }
    }, 100);
  }

  // 关闭弹窗
  const modal = $('channelModelsModal');
  if (modal) modal.classList.remove('show');
};

/**
 * 全选当前列表中的可见模型
 */
export const selectAllVisibleModels = () => {
  if (isModelsListReadonly) {
    notifications.info('只读模式下无法选择模型');
    return;
  }

  const checkboxes = getVisibleModelCheckboxes();
  if (checkboxes.length === 0) {
    notifications.info('暂无可选模型');
    updateAddToMappingButtonState();
    return;
  }

  const channel = state.channels.find(c => c.id == state.currentChannelId);
  const channelInfo = channel ? { id: channel.id, name: channel.name } : null;
  let addedCount = 0;

  checkboxes.forEach(cb => {
    const model = cb.dataset.model;
    const exists = setOps.hasModel(model);
    setOps.addModel(model, channelInfo);
    if (!state.mappings.hasOwnProperty(model)) {
      state.mappings[model] = model;
    }
    if (!state.modelChannelMap[model] && channelInfo) {
      state.modelChannelMap[model] = channelInfo;
    }
    updateModelItemSelection(cb, true);
    if (!exists) addedCount++;
  });

  updateSelectedDisplay();
  renderModalSelectedModels();
  updateAddToMappingButtonState();
  persistMappings();

  if (addedCount > 0) {
    notifications.success(`已选择 ${checkboxes.length} 个模型，新增 ${addedCount} 个`);
  } else {
    notifications.info(`已选择 ${checkboxes.length} 个模型，均已在映射中`);
  }
};

/**
 * 取消当前列表中的可见模型
 */
export const deselectAllVisibleModels = () => {
  if (isModelsListReadonly) {
    notifications.info('只读模式下无法取消选择');
    return;
  }

  const checkboxes = getVisibleModelCheckboxes();
  if (checkboxes.length === 0) {
    notifications.info('暂无可取消模型');
    updateAddToMappingButtonState();
    return;
  }

  let removedCount = 0;
  checkboxes.forEach(cb => {
    if (!cb.checked) return;
    const model = cb.dataset.model;
    setOps.removeModel(model);
    updateModelItemSelection(cb, false);
    removedCount++;
  });

  updateSelectedDisplay();
  renderModalSelectedModels();
  updateAddToMappingButtonState();
  persistMappings();

  if (removedCount > 0) {
    notifications.success(`已取消 ${removedCount} 个模型`);
  } else {
    notifications.info('当前无选中模型');
  }
};

/**
 * 清空当前渠道的已选模型
 */
export const clearSelectedModelsForCurrentChannel = () => {
  if (!state.currentChannelId) {
    notifications.warning('请先打开渠道模型');
    return;
  }

  const selectedModels = getSelectedModelsForCurrentChannel();
  if (selectedModels.length === 0) {
    notifications.info('当前渠道暂无已选模型');
    return;
  }

  selectedModels.forEach(model => setOps.removeModel(model));
  updateSelectedDisplay();
  renderModalSelectedModels();
  renderModelsList('', false);
  persistMappings();

  notifications.success(`已清空 ${selectedModels.length} 个模型`);
};

/**
 * 复制当前渠道已选模型
 */
export const copySelectedModelsForCurrentChannel = async () => {
  const selectedModels = getSelectedModelsForCurrentChannel();
  if (selectedModels.length === 0) {
    notifications.warning('没有可复制的模型');
    return;
  }

  try {
    await copyToClipboard(selectedModels.join('\n'));
    notifications.success(`已复制 ${selectedModels.length} 个模型`);
  } catch (error) {
    notifications.warning('复制失败，请重试');
  }
};

/**
 * 刷新当前渠道模型列表
 */
export const refreshCurrentChannelModels = async () => {
  if (!state.currentChannelId) {
    notifications.warning('请先打开渠道模型');
    return;
  }

  const channelId = state.currentChannelId;
  modelCache.clearChannel(channelId);

  const modelsList = $('modelsList');
  if (modelsList) {
    modelsList.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
  }

  const res = await fetchChannelModelsWithCache(channelId, { forceRefresh: true });
  if (res.success && res.data) {
    state.channelModels = res.data;
    renderModelsList('', false);
    renderModalSelectedModels();
    notifications.success('已刷新模型列表');
  } else {
    if (modelsList) {
      const message = res.message ? `加载失败: ${res.message}` : '暂无模型';
      modelsList.innerHTML = `<div class="empty-state">${message}</div>`;
    }
    notifications.warning(res.message || '刷新失败');
  }
};

const getAvailableModelsForCurrentChannel = () => {
  const channelId = state.currentChannelId;
  if (!channelId) return [];
  const cached = modelCache.get(channelId);
  if (cached && cached.length > 0) return cached;
  if (Array.isArray(state.channelModels) && state.channelModels.length > 0) {
    return state.channelModels;
  }
  return [];
};

const findAvailableModelName = (modelName, models) => {
  if (!modelName || !Array.isArray(models)) return null;
  const exact = models.find(item => item === modelName);
  if (exact) return exact;
  const lowerName = modelName.toLowerCase();
  return models.find(item => item.toLowerCase() === lowerName) || null;
};

const syncAvailableModelsSelectionDisplay = (modelName, selected = true) => {
  const modelsList = $('modelsList');
  if (!modelsList) return;
  modelsList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (cb.dataset.model === modelName) {
      updateModelItemSelection(cb, selected);
    }
  });
  updateGroupSelectedCounts();
};

const isOriginalModelsModalOpen = () => {
  const modal = $('newAPIModelsModal');
  return Boolean(modal && modal.classList.contains('show'));
};

const syncOriginalModelsSelectionDisplay = () => {
  if (!isOriginalModelsModalOpen()) return;
  const listEl = $('newAPIModelsList');
  if (!listEl) return;
  const selectedLookup = new Set(setOps.getModelsArray().map(model => model.toLowerCase()));
  listEl.querySelectorAll('.model-item').forEach(item => {
    const originalName = item.dataset.original || item.dataset.model;
    const mappedName = item.dataset.mapped || '';
    const targetName = mappedName || originalName;
    if (!targetName) return;
    const isSelected = selectedLookup.has(targetName.toLowerCase());
    item.classList.toggle('selected', isSelected);

    const existingBadge = item.querySelector('.badge-selected');
    if (isSelected && !existingBadge) {
      const badge = document.createElement('span');
      badge.className = 'badge-selected';
      badge.textContent = '已选';
      item.appendChild(badge);
    } else if (!isSelected && existingBadge) {
      existingBadge.remove();
    }
  });
};

const renderNewAPIModels = (channelName) => {
  const countEl = $('newAPIModelsCount');
  const listEl = $('newAPIModelsList');
  const titleEl = $('newAPIModelsTitle');

  if (titleEl) {
    titleEl.textContent = channelName ? `${channelName} - 原有模型` : '原有模型';
  }

  if (countEl) countEl.textContent = `共 ${currentOriginalModels.length} 个模型`;

  if (!listEl) return;

  if (!currentOriginalModels || currentOriginalModels.length === 0) {
    listEl.innerHTML = '<div class="empty-state">该渠道暂无原有模型</div>';
    return;
  }

  const selectedLookup = new Set(setOps.getModelsArray().map(model => model.toLowerCase()));
  listEl.innerHTML = currentOriginalModels.map(model => {
    const originalName = String(model || '').trim();
    const mappedName = getMappedModelName(originalName);
    const normalizedMapped = mappedName && mappedName.toLowerCase() !== originalName.toLowerCase()
      ? mappedName
      : '';
    const targetName = normalizedMapped || originalName;
    const isSelected = targetName && selectedLookup.has(targetName.toLowerCase());
    const title = normalizedMapped ? `映射: ${normalizedMapped}` : originalName;
    const mappedAttr = normalizedMapped ? ` data-mapped="${normalizedMapped}"` : '';
    return `
      <div class="model-item ${isSelected ? 'selected' : ''}" data-model="${originalName}" data-original="${originalName}"${mappedAttr}>
        <span class="model-name" title="${title}">${originalName}</span>
        ${isSelected ? '<span class="badge-selected">已选</span>' : ''}
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.model-item').forEach(item => {
    item.addEventListener('click', () => {
      const originalName = item.dataset.original || item.dataset.model;
      const mappedName = item.dataset.mapped || '';
      if (!originalName) return;
      selectOriginalModelFromList(originalName, mappedName, item);
    });
  });
};

const selectOriginalModelFromList = (originalName, mappedName, itemEl = null) => {
  const channel = getCachedChannelById(state.currentChannelId);
  const channelInfo = channel ? { id: channel.id, name: channel.name } : null;
  const targetCandidate = String(mappedName || originalName || '').trim();

  if (!targetCandidate) return;

  const availableModels = getAvailableModelsForCurrentChannel();
  if (!availableModels || availableModels.length === 0) {
    notifications.warning('未找到该渠道可用模型缓存，请先加载可用模型');
    return;
  }

  const resolvedTarget = findAvailableModelName(targetCandidate, availableModels);
  if (!resolvedTarget) {
    const label = mappedName ? '映射模型' : '原有模型';
    notifications.warning(`${label}不存在: ${targetCandidate}`);
    return;
  }

  if (setOps.hasModel(resolvedTarget)) {
    notifications.info('该模型已在映射中');
    syncOriginalModelsSelectionDisplay();
    return;
  }

  setOps.addModel(resolvedTarget, channelInfo);
  updateSelectedDisplay();
  renderModalSelectedModels();
  updateAddToMappingButtonState();
  persistMappings();

  syncAvailableModelsSelectionDisplay(resolvedTarget, true);

  if (itemEl) itemEl.classList.add('selected');

  if (mappedName) {
    notifications.success(`已选择映射模型: ${resolvedTarget}`);
  } else {
    notifications.success(`已选择原有模型: ${resolvedTarget}`);
  }
};

const loadNewAPISelectedModels = async ({ forceRefresh = false } = {}) => {
  if (!state.currentChannelId) {
    return { success: false, message: '请先打开渠道模型' };
  }

  const channelId = state.currentChannelId;
  const cachedChannel = getCachedChannelById(channelId);
  const cachedModels = !forceRefresh ? extractModelsFromChannel(cachedChannel) : [];
  const cachedMapping = parseModelMapping(cachedChannel?.model_mapping);

  if (cachedModels.length > 0) {
    currentOriginalModels = cachedModels;
    currentOriginalMapping = buildModelMappingLookup(cachedMapping);
    return { success: true, data: cachedModels, fromCache: true };
  }

  try {
    const res = await getChannelModels(state.config, channelId, { fetchSelectedOnly: true, forceRefresh });
    if (res && res.success && Array.isArray(res.data)) {
      const normalized = normalizeModels(res.data);
      currentOriginalModels = normalized;
      currentOriginalMapping = buildModelMappingLookup(cachedMapping);
      if (cachedChannel) {
        cachedChannel.models = normalized.join(',');
        setChannelsCache(state.channels);
      }
      return { success: true, data: normalized, fromCache: false };
    }
    currentOriginalModels = [];
    currentOriginalMapping = new Map();
    return { success: false, message: res.message || '获取失败' };
  } catch (error) {
    currentOriginalModels = [];
    currentOriginalMapping = new Map();
    return { success: false, message: error.message };
  }
};

/**
 * 打开原有模型弹窗
 */
export const openNewAPIModelsModal = async () => {
  if (!state.currentChannelId) {
    notifications.warning('请先打开一个渠道的模型管理');
    return;
  }

  const modal = $('newAPIModelsModal');
  if (modal) {
    modal.classList.add('show');
    modal.classList.remove('active');
  }
  const listEl = $('newAPIModelsList');
  if (listEl) {
    listEl.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
  }

  const channel = getCachedChannelById(state.currentChannelId);
  const channelName = channel ? channel.name : '';

  const result = await loadNewAPISelectedModels();
  if (!result.success) {
    notifications.warning(result.message || '获取失败');
  }

  renderNewAPIModels(channelName);
};

/**
 * 刷新原有模型
 */
export const refreshNewAPIModels = async () => {
  const channel = getCachedChannelById(state.currentChannelId);
  const channelName = channel ? channel.name : '';
  const listEl = $('newAPIModelsList');
  if (listEl) {
    listEl.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
  }
  const result = await loadNewAPISelectedModels({ forceRefresh: true });

  if (!result.success) {
    notifications.warning(result.message || '获取失败');
  }

  renderNewAPIModels(channelName);
};

/**
 * 复制原有模型
 */
export const copyNewAPIModels = async () => {
  if (!currentOriginalModels || currentOriginalModels.length === 0) {
    notifications.warning('没有可复制的模型');
    return;
  }

  try {
    await copyToClipboard(currentOriginalModels.join('\n'));
    notifications.success(`已复制 ${currentOriginalModels.length} 个模型`);
  } catch (error) {
    notifications.warning('复制失败，请重试');
  }
};

/**
 * 过滤渠道
 */
export const filterChannels = (searchTerm) => {
  renderChannels(searchTerm);
};

/**
 * 查看渠道模型（只读模式）
 */
export const viewChannelModels = async (channelId, channelName) => {
  const channel = state.channels.find(c => c.id == channelId);
  if (!channel) {
    notifications.error('未找到渠道信息');
    return;
  }

  state.currentChannelId = channelId;
  currentOriginalModels = [];
  currentOriginalMapping = new Map();

  // 打开弹窗（只读模式）
  const modal = $('channelModelsModal');
  if (modal) {
    const title = $('channelModelsTitle');
    if (title) title.textContent = `${channelName || channel.name} 的模型`;

    // 隐藏添加按钮（只读模式）
    const addBtn = $('addToMappingBtn');
    if (addBtn) addBtn.style.display = 'none';

    modal.classList.add('show');
    modal.classList.remove('active');
  }

  // 渲染当前渠道已选模型
  renderModalSelectedModels();

  // 加载模型
  const modelsList = $('modelsList');
  if (modelsList) {
    modelsList.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
  }

  // 检查缓存
  const cached = modelCache.get(channelId);
  if (cached) {
    state.channelModels = cached;
    renderModelsList('', true);  // 只读模式
    return;
  }

  const res = await fetchChannelModelsWithCache(channelId);
  if (res.success && res.data) {
    state.channelModels = res.data;
    renderModelsList('', true);  // 只读模式
  } else {
    const list = $('modelsList');
    if (list) {
      const message = res.message ? `加载失败: ${res.message}` : '暂无模型';
      list.innerHTML = `<div class="empty-state">${message}</div>`;
    }
  }
};

/**
 * 选择渠道（添加到选中列表）
 */
export const selectChannel = (channelId) => {
  const channel = state.channels.find(c => c.id == channelId);
  if (!channel) return;

  // 添加到选中渠道
  setOps.addChannel(channelId);

  // 重新渲染渠道卡片
  renderChannels();

  notifications.success(`已选择渠道: ${channel.name}`);
};

/**
 * 全选当前渠道的所有模型
 */
export const selectAllModelsFromChannel = async (channelId) => {
  const channel = state.channels.find(c => c.id == channelId);
  if (!channel) return;

  const channelInfo = { id: channel.id, name: channel.name };

  // 获取渠道模型
  let models = modelCache.get(channelId);
  if (!models) {
    const res = await fetchChannelModelsWithCache(channelId);
    if (res.success) {
      models = res.data;
    }
  }

  if (!models || models.length === 0) {
    notifications.warning('该渠道暂无模型');
    return;
  }

  // 全选所有模型
  let count = 0;
  models.forEach(model => {
    if (!setOps.hasModel(model)) {
      setOps.addModel(model, channelInfo);
      state.mappings[model] = model;
      state.modelChannelMap[model] = channelInfo;
      count++;
    }
  });

  notifications.success(`已全选 ${count} 个模型`);
  updateSelectedDisplay();
  renderModalSelectedModels();
  persistMappings();
};

/**
 * 全选原有模型模态框中的所有模型
 */
export const selectAllNewAPIModels = () => {
  if (!currentOriginalModels || currentOriginalModels.length === 0) {
    notifications.warning('暂无模型');
    return;
  }

  const channel = getCachedChannelById(state.currentChannelId);
  const channelInfo = channel ? { id: channel.id, name: channel.name } : null;
  const availableModels = getAvailableModelsForCurrentChannel();

  let count = 0;
  currentOriginalModels.forEach(originalName => {
    const mappedName = getMappedModelName(originalName);
    const targetCandidate = String(mappedName || originalName || '').trim();
    if (!targetCandidate) return;

    const resolvedTarget = findAvailableModelName(targetCandidate, availableModels);
    if (!resolvedTarget) return;

    if (!setOps.hasModel(resolvedTarget)) {
      setOps.addModel(resolvedTarget, channelInfo);
      state.mappings[resolvedTarget] = resolvedTarget;
      state.modelChannelMap[resolvedTarget] = channelInfo;
      count++;
    }
  });

  notifications.success(`已全选 ${count} 个原有模型`);
  updateSelectedDisplay();
  renderModalSelectedModels();
  renderNewAPIModels(channel?.name || '');
};

/**
 * 切换渠道选中状态（保留用于向后兼容）
 */
export const toggleChannelSelection = (channelId) => {
  setOps.toggleChannel(channelId);
  updateChannelStats();
};

/**
 * 更新渠道统计
 */
const updateChannelStats = () => {
  const statsEl = $('channelsStats');
  if (statsEl) {
    const totalChannels = state.channels.length;
    const activeChannels = state.channels.filter(c => c.status === 1).length;

    statsEl.innerHTML = `
      <div class="stat-item">
        <div class="stat-value">${totalChannels}</div>
        <div class="stat-label">总渠道</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${activeChannels}</div>
        <div class="stat-label">已启用</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${setOps.getModelsArray().length}</div>
        <div class="stat-label">已选模型</div>
      </div>
    `;
  }
};

/**
 * 获取选中的渠道
 */
export const getSelectedChannels = () => {
  return state.channels.filter(c => setOps.hasChannel(c.id));
};

/**
 * 重置所有选中
 */
export const clearAllSelections = () => {
  setOps.clearModels();
  setOps.clearChannels();
  try {
    localStorage.removeItem(STORAGE_KEYS.MODEL_MAPPINGS);
    localStorage.removeItem('newapi-model-channel-map');
  } catch (error) {
    console.warn('清理选择缓存失败:', error);
  }
  renderChannels();
  updateSelectedDisplay();
  renderModalSelectedModels();
  renderModelsList('', false);
  notifications.success('已清除所有选择');
};

/**
 * 更新选中模型显示
 */
export const updateSelectedDisplay = () => {
  const container = $('selectedModelsContainer');
  const list = $('selectedModelsList');
  const count = $('selectedModelsCountChannels');

  if (!container) return;

  const models = setOps.getModelsArray();

  if (count) {
    count.textContent = `已选模型 (${models.length})`;
  }

  // 更新渠道统计中的已选模型数量
  updateChannelStats();

  if (models.length === 0) {
    container.style.display = 'none';
    if (list) list.innerHTML = '<div class="empty-state">暂未选择模型</div>';
    updateGroupSelectedCounts();
    syncOriginalModelsSelectionDisplay();
    return;
  }

  container.style.display = '';
  if (list) {
    list.innerHTML = models.map(model => {
      const channelInfo = state.modelChannelMap[model];
      const channelName = (channelInfo && channelInfo.name) || '未知渠道';
      return `
        <div class="selected-model-item">
          <span class="model-name" title="${model}">${model}</span>
          <span class="model-channel">${channelName}</span>
          <button class="btn-remove" data-model="${model}" title="移除">
            <i class="fas fa-times"></i>
          </button>
        </div>
      `;
    }).join('');

    // 绑定移除按钮事件
    list.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSelectedModel(btn.dataset.model);
      });
    });
  }

  updateGroupSelectedCounts();
  syncOriginalModelsSelectionDisplay();
};

/**
 * 移除选中的模型
 */
export const removeSelectedModel = (model) => {
  setOps.removeModel(model);
  delete state.mappings[model];
  delete state.modelChannelMap[model];
  // 同步从 selectedModels 数组中移除
  state.selectedModels = state.selectedModels.filter(m => m !== model);
  updateSelectedDisplay();
  renderModalSelectedModels();
  renderModelsList('', false);  // 更新模型列表中的选中状态
  persistMappings();
  notifications.success(`已移除模型: ${model}`);
};

/**
 * 获取渠道统计信息
 */
export const getChannelStats = () => {
  return {
    total: state.channels.length,
    active: state.channels.filter(c => c.status === 1).length,
    disabled: state.channels.filter(c => c.status !== 1).length,
    withModels: state.channels.filter(c => c.models && c.models.length > 0).length
  };
};

export default {
  loadChannels,
  renderChannels,
  openChannelModelsModal,
  renderModelsList,
  renderModalSelectedModels,
  addSelectedModelsToMapping,
  clearSelectedModelsForCurrentChannel,
  copySelectedModelsForCurrentChannel,
  refreshCurrentChannelModels,
  openNewAPIModelsModal,
  refreshNewAPIModels,
  copyNewAPIModels,
  selectAllNewAPIModels,
  filterChannels,
  getChannelStats,
  viewChannelModels,
  selectChannel,
  selectAllModelsFromChannel,
  selectAllVisibleModels,
  deselectAllVisibleModels,
  toggleChannelSelection,
  getSelectedChannels,
  clearAllSelections,
  updateSelectedDisplay,
  removeSelectedModel,
  updateTagFilterOptions,
  setTagFilter,
  setSortBy,
  clearChannelsCache,
  prefetchAllChannelModels
};

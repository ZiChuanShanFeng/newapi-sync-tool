/**
 * 同步功能模块
 */
import { state, setOps } from '../../core/state.js';
import { batchSync, createCheckpoint, restoreCheckpoint } from '../../api/sync.js';
import { $ } from '../../ui/dom.js';
import { addLog, setProgress } from '../../ui/dom.js';
import { notifications } from '../../ui/notifications.js';
import { progress } from '../../ui/progress.js';
import { getLastCheckpoint, setLastCheckpoint } from '../../core/checkpoint.js';

const updateRollbackButton = () => {
  const btn = $('rollbackSyncBtn');
  if (!btn) return;
  const checkpoint = getLastCheckpoint();
  const hasCheckpoint = Boolean(checkpoint && checkpoint.id);
  btn.disabled = !hasCheckpoint || state.isSyncing;
  if (hasCheckpoint) {
    const timeText = checkpoint.createdAt
      ? new Date(checkpoint.createdAt).toLocaleString('zh-CN')
      : '';
    btn.title = timeText ? `检查点 ${checkpoint.id} (${timeText})` : `检查点 ${checkpoint.id}`;
  } else {
    btn.title = '暂无可回退的检查点';
  }
};

const formatCheckpointWarning = (checkpointResult) => {
  const failed = Number(checkpointResult?.failed || 0);
  if (failed > 0) {
    return `注意：${failed} 个渠道未写入检查点`;
  }
  return '';
};

/**
 * 开始同步
 */
export const startSync = async (mode = 'append') => {
  if (state.isSyncing) {
    notifications.warning('同步正在进行中');
    return { success: false, message: '同步正在进行中' };
  }

  // 令牌可由服务端加密存储并自动补全，浏览器侧不强制持有
  if (!state.config.baseUrl || !state.config.userId || (!state.config.token && !state.hasServerConfig)) {
    notifications.error('请先配置连接信息');
    return { success: false, message: '请先配置连接信息' };
  }

  if (Object.keys(state.mappings).length === 0) {
    notifications.warning('请先生成模型映射');
    return { success: false, message: '请先生成模型映射' };
  }

  const firstConfirm = window.confirm('即将创建检查点并执行同步操作，是否继续？');
  if (!firstConfirm) {
    return { success: false, message: '用户取消' };
  }

  state.isSyncing = true;

  // UI 初始化
  const syncSection = $('syncSection');
  if (syncSection) syncSection.classList.remove('hidden');

  const logsContainer = $('syncLogs');
  if (logsContainer) logsContainer.innerHTML = '';

  progress.start('progressFill', 'progressText', '创建检查点...');
  addLog('syncLogs', '创建检查点...');

  try {
    // 更新进度
    progress.update('progressFill', 'progressText', 30, '创建检查点...');

    // 获取选中的渠道 ID
    // 优先使用手动选择的渠道，否则从选中模型的渠道信息中提取
    let selectedChannelIds = setOps.getChannelsArray();

    if (selectedChannelIds.length === 0) {
      // 从 selectedModels 中提取选中模型对应的渠道ID
      const channelIdSet = new Set();
      for (const item of state.selectedModels) {
        if (item.channelId != null) {
          channelIdSet.add(item.channelId);
        }
      }
      selectedChannelIds = Array.from(channelIdSet);
    }

    const channelIds = selectedChannelIds.length > 0 ? selectedChannelIds : null;

    const checkpointResult = await createCheckpoint(channelIds, {
      tag: 'sync',
      concurrency: 6
    });

    if (!checkpointResult?.success) {
      progress.fail('progressFill', 'progressText', '检查点创建失败');
      addLog('syncLogs', `检查点创建失败: ${checkpointResult?.message || '未知错误'}`, 'error');
      notifications.error(`检查点创建失败: ${checkpointResult?.message || '未知错误'}`);
      return { success: false, message: checkpointResult?.message || '检查点创建失败' };
    }

    const checkpointInfo = {
      id: checkpointResult.checkpointId,
      createdAt: checkpointResult.createdAt,
      count: checkpointResult.count,
      tag: 'sync'
    };
    setLastCheckpoint(checkpointInfo);
    updateRollbackButton();

    const checkpointWarning = formatCheckpointWarning(checkpointResult);
    if (checkpointWarning) {
      addLog('syncLogs', checkpointWarning, 'warning');
      notifications.warning(checkpointWarning);
    }

    const warningText = checkpointWarning ? `\n${checkpointWarning}` : '';
    const secondConfirm = window.confirm(
      `检查点已创建（${checkpointInfo.id}）。${warningText}\n确认继续同步？`
    );
    if (!secondConfirm) {
      progress.reset('progressFill', 'progressText', '已取消');
      addLog('syncLogs', '已取消同步', 'warning');
      notifications.info('已取消同步');
      return { success: false, message: '用户取消' };
    }

    progress.update('progressFill', 'progressText', 30, '正在同步...');
    addLog('syncLogs', '开始同步模型映射...');

    if (channelIds && channelIds.length > 0) {
      addLog('syncLogs', `📋 同步到 ${channelIds.length} 个渠道: ${channelIds.join(', ')}`);
    } else {
      addLog('syncLogs', `⚠️ 未找到关联渠道，请先选择模型`, 'warning');
      progress.fail('progressFill', 'progressText', '无渠道可同步');
      notifications.warning('未找到关联渠道，请先选择模型');
      return { success: false, message: '未找到关联渠道' };
    }

    // 执行同步 - 按渠道拆分映射，避免跨渠道混用
    // 前端发送格式: { 原始模型名: 新模型名 }
    const channelIdSet = new Set(channelIds);
    const channelMappingsMap = new Map();

    console.log('🔍 [前端] 开始构建分渠道 modelMapping');
    console.log('🔍 [前端] 选中的渠道ID:', Array.from(channelIdSet));
    console.log('🔍 [前端] state.mappings 条目数:', Object.keys(state.mappings).length);

    for (const [compositeKey, mapping] of Object.entries(state.mappings)) {
      console.log(`🔍 [前端] 检查映射: ${compositeKey}`, mapping);
      if (!mapping || !mapping.model || mapping.channelId == null) {
        continue;
      }

      if (!channelIdSet.has(mapping.channelId)) {
        console.log(`⏭️ [前端] 跳过映射 (渠道不匹配): ${compositeKey}, 渠道ID ${mapping.channelId}`);
        continue;
      }

      const originalModel = mapping.model;
      const targetModel = mapping.targetModel || mapping.model;
      let entry = channelMappingsMap.get(mapping.channelId);
      if (!entry) {
        entry = { channelId: mapping.channelId, mapping: {} };
        channelMappingsMap.set(mapping.channelId, entry);
      }
      entry.mapping[targetModel] = originalModel;
      console.log(`✅ [前端] 添加映射: ${targetModel} → ${originalModel} (渠道 ${mapping.channelId})`);
    }

    const channelMappings = Array.from(channelMappingsMap.values())
      .filter(item => Object.keys(item.mapping || {}).length > 0);

    if (channelMappings.length === 0) {
      addLog('syncLogs', `⚠️ 未找到可同步的映射`, 'warning');
      progress.fail('progressFill', 'progressText', '无映射可同步');
      notifications.warning('未找到可同步的映射');
      return { success: false, message: '未找到可同步的映射' };
    }

    const result = await batchSync(
      state.config,
      channelMappings,
      mode,
      ({ current, total }) => {
        const percent = 30 + Math.round((current / total) * 60);
        progress.update('progressFill', 'progressText', percent, `正在同步... (${current}/${total})`);
      }
    );

    const stats = {
      success: result.success || 0,
      failed: result.failed || 0,
      unchanged: result.unchanged || 0
    };

    const hasFailures = stats.failed > 0;
    const successMsg = `✅ 同步完成: 成功 ${stats.success || 0} 个渠道`;
    const failedMsg = stats.failed > 0 ? `, 失败 ${stats.failed} 个` : '';
    const unchangedMsg = stats.unchanged > 0 ? `, 未变更 ${stats.unchanged} 个` : '';
    addLog('syncLogs', successMsg + failedMsg + unchangedMsg, hasFailures ? 'warning' : 'success');

    if (result.logs) {
      result.logs.forEach(log => addLog('syncLogs', log));
    }

    if (hasFailures) {
      progress.fail('progressFill', 'progressText', stats.success > 0 ? '部分完成' : '同步失败');
      notifications.warning('同步完成（部分失败）');
      return { success: false, stats, logs: result.logs };
    }

    progress.complete('progressFill', 'progressText', '同步完成!');
    notifications.success('同步完成');
    return { success: true, stats, logs: result.logs };
  } catch (error) {
    progress.fail('progressFill', 'progressText', '同步失败');
    addLog('syncLogs', `❌ 同步失败: ${error.message}`, 'error');
    notifications.error(`同步失败: ${error.message}`);
    return { success: false, message: error.message };
  } finally {
    state.isSyncing = false;
    updateRollbackButton();
  }
};

/**
 * 批量同步（按渠道分组）
 */
export const batchSyncChannels = async (channelMappings, onProgress) => {
  if (state.isSyncing) {
    notifications.warning('同步正在进行中');
    return { success: false, message: '同步正在进行中' };
  }

  if (!channelMappings || channelMappings.length === 0) {
    notifications.warning('没有可同步的渠道');
    return { success: false, message: '没有可同步的渠道' };
  }

  state.isSyncing = true;

  const logsContainer = $('syncLogs');
  if (logsContainer) logsContainer.innerHTML = '';

  addLog('syncLogs', '创建检查点...');

  try {
    const channelIds = channelMappings
      .map(item => item?.channelId)
      .filter(id => id != null);

    const checkpointResult = await createCheckpoint(channelIds, {
      tag: 'batch-sync',
      concurrency: 6
    });

    if (!checkpointResult?.success) {
      addLog('syncLogs', `检查点创建失败: ${checkpointResult?.message || '未知错误'}`, 'error');
      notifications.error(`检查点创建失败: ${checkpointResult?.message || '未知错误'}`);
      return { success: false, message: checkpointResult?.message || '检查点创建失败' };
    }

    const checkpointInfo = {
      id: checkpointResult.checkpointId,
      createdAt: checkpointResult.createdAt,
      count: checkpointResult.count,
      tag: 'batch-sync'
    };
    setLastCheckpoint(checkpointInfo);
    updateRollbackButton();

    const checkpointWarning = formatCheckpointWarning(checkpointResult);
    if (checkpointWarning) {
      addLog('syncLogs', checkpointWarning, 'warning');
      notifications.warning(checkpointWarning);
    }

    const warningText = checkpointWarning ? `\n${checkpointWarning}` : '';
    const secondConfirm = window.confirm(
      `检查点已创建（${checkpointInfo.id}）。${warningText}\n确认继续批量同步？`
    );
    if (!secondConfirm) {
      addLog('syncLogs', '已取消批量同步', 'warning');
      notifications.info('已取消批量同步');
      return { success: false, message: '用户取消' };
    }

    addLog('syncLogs', `开始批量同步 ${channelMappings.length} 个渠道...`);

    const results = await batchSync(state.config, channelMappings, onProgress);

    addLog('syncLogs', `✅ 批量同步完成: 成功 ${results.success}, 失败 ${results.failed}`, 'success');

    if (results.errors.length > 0) {
      addLog('syncLogs', `❌ 以下渠道同步失败:`, 'error');
      results.errors.forEach(e => addLog('syncLogs', `  - 渠道 ${e.channelId}: ${e.error}`, 'error'));
    }

    notifications.success(`批量同步完成: 成功 ${results.success}, 失败 ${results.failed}`);
    return { success: true, results };
  } catch (error) {
    addLog('syncLogs', `❌ 批量同步失败: ${error.message}`, 'error');
    notifications.error(`批量同步失败: ${error.message}`);
    return { success: false, message: error.message };
  } finally {
    state.isSyncing = false;
    updateRollbackButton();
  }
};

/**
 * 回退到上次检查点
 */
export const restoreLastCheckpoint = async () => {
  if (state.isSyncing) {
    notifications.warning('同步正在进行中');
    return { success: false, message: '同步正在进行中' };
  }

  const checkpoint = getLastCheckpoint();
  if (!checkpoint || !checkpoint.id) {
    notifications.warning('暂无可回退的检查点');
    return { success: false, message: '暂无可回退的检查点' };
  }

  const firstConfirm = window.confirm(`即将回退到检查点 ${checkpoint.id}，当前修改将被覆盖，是否继续？`);
  if (!firstConfirm) {
    return { success: false, message: '用户取消' };
  }

  const secondConfirm = window.confirm('请再次确认回退操作，是否继续？');
  if (!secondConfirm) {
    return { success: false, message: '用户取消' };
  }

  state.isSyncing = true;

  const logsContainer = $('syncLogs');
  if (logsContainer) logsContainer.innerHTML = '';

  progress.start('progressFill', 'progressText', '正在回退...');
  addLog('syncLogs', `开始回退到检查点 ${checkpoint.id}...`);

  try {
    const result = await restoreCheckpoint(checkpoint.id, { concurrency: 6 });

    if (result.success) {
      progress.complete('progressFill', 'progressText', '回退完成');
      addLog('syncLogs', `回退完成: ${result.restored} 个渠道`, 'success');
      if (result.failed > 0) {
        addLog('syncLogs', `回退失败: ${result.failed} 个渠道`, 'warning');
      }
      notifications.success('回退完成');
      return { success: true, result };
    }

    progress.fail('progressFill', 'progressText', '回退失败');
    addLog('syncLogs', `回退失败: ${result.message || '未知错误'}`, 'error');
    notifications.error(`回退失败: ${result.message || '未知错误'}`);
    return { success: false, message: result.message || '回退失败' };
  } catch (error) {
    progress.fail('progressFill', 'progressText', '回退失败');
    addLog('syncLogs', `回退失败: ${error.message}`, 'error');
    notifications.error(`回退失败: ${error.message}`);
    return { success: false, message: error.message };
  } finally {
    state.isSyncing = false;
    updateRollbackButton();
  }
};

/**
 * 获取同步状态
 */
export const getSyncStatus = () => {
  return {
    isSyncing: state.isSyncing,
    mappingsCount: Object.keys(state.mappings).length,
    channelsCount: state.channels.length
  };
};

/**
 * 取消同步
 */
export const cancelSync = () => {
  state.isSyncing = false;
  progress.reset('progressFill', 'progressText', '同步已取消');
  addLog('syncLogs', '⚠️ 同步已取消');
  notifications.info('同步已取消');
  updateRollbackButton();
};

updateRollbackButton();

export default {
  startSync,
  batchSyncChannels,
  restoreLastCheckpoint,
  getSyncStatus,
  cancelSync
};

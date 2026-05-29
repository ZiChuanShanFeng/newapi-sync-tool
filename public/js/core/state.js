/**
 * 状态管理模块
 * 集中管理应用状态
 */
import { DEFAULT_CONFIG, CACHE_CONFIG, STORAGE_KEYS } from './constants.js';

// 主状态
export const state = {
  // 配置
  config: { ...DEFAULT_CONFIG },
  // 服务端是否已保存配置（令牌仅存于服务端，浏览器不持有）
  hasServerConfig: false,

  // 数据
  channels: [],
  selectedModels: [],  // 使用 Array 存储选中模型（与 mapping 模块保持一致）
  selectedChannels: new Set(),  // 选中的渠道
  mappings: {},
  modelChannelMap: {},

  // UI 状态
  currentChannelId: null,
  channelModels: [],
  isLoading: false,
  isSyncing: false,
  theme: localStorage.getItem(STORAGE_KEYS.THEME) || 'light',
  runtimeMode: 'node',

  // 搜索
  searchHistory: [],
  globalSearchResults: [],

  // 选项
  options: {
    smartMatch: true,
    autoSuffix: false,
    smartMerge: false
  }
};

// 模型缓存
class ModelCache {
  constructor() {
    this.cache = new Map();
    this.maxAge = CACHE_CONFIG.maxAge;
  }

  normalizeKey(channelId) {
    return String(channelId);
  }

  set(channelId, models) {
    const key = this.normalizeKey(channelId);
    this.cache.set(key, {
      data: models,
      timestamp: Date.now()
    });
  }

  get(channelId) {
    const key = this.normalizeKey(channelId);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  has(channelId) {
    return this.get(channelId) !== null;
  }

  clear() {
    this.cache.clear();
  }

  clearChannel(channelId) {
    const key = this.normalizeKey(channelId);
    this.cache.delete(key);
  }

  setMaxAge(maxAge) {
    const normalized = Number(maxAge);
    if (!Number.isFinite(normalized) || normalized <= 0) return;
    this.maxAge = normalized;
  }

  // 获取所有缓存的模型
  getAll() {
    const result = {};
    for (const [channelId, entry] of this.cache) {
      if (Date.now() - entry.timestamp <= this.maxAge) {
        result[channelId] = entry.data;
      }
    }
    return result;
  }
}

export const modelCache = new ModelCache();

// 状态持久化
export const saveState = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`保存状态失败 ${key}:`, error);
  }
};

export const loadState = (key, defaultValue = null) => {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : defaultValue;
  } catch (error) {
    console.warn(`加载状态失败 ${key}:`, error);
    return defaultValue;
  }
};

/**
 * 迁移/清理旧格式数据
 * 将旧格式的 selectedModels 和 mappings 转换为新格式
 * 注意：此函数在 channels 加载完成后调用，以补充渠道名称
 */
export const migrateMappingsAfterChannelsLoad = () => {
  const savedMappings = loadState(STORAGE_KEYS.MODEL_MAPPINGS, null);
  
  if (!savedMappings) return;
  
  let needsSave = false;
  
  // 检查是否是旧格式（键是模型名，不是复合键）
  const firstKey = Object.keys(savedMappings)[0];
  if (!firstKey || !firstKey.includes(':')) {
    console.log('🔄 检测到旧格式数据，正在清理...');
    // 旧格式数据，直接清空（用户需要重新选择模型）
    localStorage.removeItem(STORAGE_KEYS.MODEL_MAPPINGS);
    state.selectedModels = [];
    state.mappings = {};
    console.log('✅ 已清理旧格式数据，请重新选择模型');
    return;
  }
  
  // 检查 mappings 值是否是旧格式（简单字符串，不是对象）
  const firstValue = savedMappings[firstKey];
  if (typeof firstValue === 'string') {
    console.log('🔄 检测到半旧格式数据，正在迁移...');
    // 半旧格式，需要迁移
    const newMappings = {};
    const newSelectedModels = [];
    
    for (const [compositeKey, targetModel] of Object.entries(savedMappings)) {
      // 解析复合键
      const { channelId, model } = setOps.parseCompositeKey(compositeKey);
      
      // 从 state.channels 中查找渠道名称
      const channel = state.channels.find(c => String(c.id) === String(channelId));
      const channelName = channel?.name || `渠道 ${channelId}`;
      
      newMappings[compositeKey] = {
        id: compositeKey,
        channelId: Number(channelId),
        channelName,
        model,
        targetModel
      };
      
      newSelectedModels.push({
        id: compositeKey,
        channelId: Number(channelId),
        channelName,
        model
      });
    }
    
    state.mappings = newMappings;
    state.selectedModels = newSelectedModels;
    saveState(STORAGE_KEYS.MODEL_MAPPINGS, newMappings);
    console.log(`✅ 已迁移 ${newSelectedModels.length} 个模型映射`);
    return;
  }
  
  // 新格式，检查数据完整性并补充渠道名称
  const newSelectedModels = [];
  for (const [compositeKey, mapping] of Object.entries(savedMappings)) {
    if (mapping && mapping.model) {
      // 补充渠道名称
      const channel = state.channels.find(c => c.id == mapping.channelId);
      const channelName = mapping.channelName || channel?.name || `渠道 ${mapping.channelId}`;
      
      // 更新 mappings 中的渠道名称
      if (!mapping.channelName && channel) {
        mapping.channelName = channelName;
        needsSave = true;
      }
      
      newSelectedModels.push({
        id: compositeKey,
        channelId: mapping.channelId,
        channelName,
        model: mapping.model
      });
    }
  }
  
  if (newSelectedModels.length > 0) {
    state.selectedModels = newSelectedModels;
    // 保存更新后的 mappings
    if (needsSave) {
      saveState(STORAGE_KEYS.MODEL_MAPPINGS, savedMappings);
    }
    console.log(`✅ 已同步 ${newSelectedModels.length} 个模型`);
  }
};

// 状态更新辅助函数
export const updateState = (path, value) => {
  const keys = path.split('.');
  let current = state;

  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current)) {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }

  current[keys[keys.length - 1]] = value;
};

// Set 操作辅助函数
export const setOps = {
  /**
   * 生成复合键：区分不同渠道的相同模型
   * @param {string|number} channelId - 渠道ID
   * @param {string} model - 模型名称
   * @returns {string} 复合键 "channelId:model"
   */
  createCompositeKey: (channelId, model) => {
    return `${channelId}:${model}`;
  },

  /**
   * 从复合键解析出 channelId 和 model
   * @param {string} compositeKey - 复合键
   * @returns {{ channelId, model }}
   */
  parseCompositeKey: (compositeKey) => {
    const [channelId, ...modelParts] = compositeKey.split(':');
    return {
      channelId: channelId,
      model: modelParts.join(':')  // 处理模型名中可能包含 : 的情况
    };
  },

  /**
   * 添加模型到选中列表
   * @param {string} model - 模型名称
   * @param {object} channelInfo - 渠道信息 { id, name }
   */
  addModel: (model, channelInfo = null) => {
    // 如果没有提供渠道信息，使用当前选中渠道或默认
    if (!channelInfo) {
      const selectedChannelIds = Array.from(state.selectedChannels);
      if (selectedChannelIds.length === 0) {
        console.warn(`添加模型 ${model} 时没有选中渠道`);
        return;
      }
      // 使用第一个选中的渠道
      const channelId = selectedChannelIds[0];
      const channel = state.channels.find(c => c.id == channelId);
      channelInfo = {
        id: channelId,
        name: channel?.name || `渠道 ${channelId}`
      };
    }

    const compositeKey = setOps.createCompositeKey(channelInfo.id, model);

    // 检查是否已存在相同复合键
    const exists = state.selectedModels.find(m => m.id === compositeKey);
    if (exists) {
      return; // 已存在，不重复添加
    }

    // 添加到 selectedModels（存储对象）
    state.selectedModels.push({
      id: compositeKey,
      channelId: channelInfo.id,
      channelName: channelInfo.name,
      model: model
    });

    // 确保 mappings 中有该模型（使用复合键）
    if (!state.mappings.hasOwnProperty(compositeKey)) {
      state.mappings[compositeKey] = {
        id: compositeKey,
        channelId: channelInfo.id,
        channelName: channelInfo.name,
        model: model,
        targetModel: model
      };
    }
  },

  /**
   * 从选中列表移除模型
   * @param {string} model - 模型名称
   * @param {string|number} channelId - 渠道ID（可选，不传则移除所有渠道的该模型）
   */
  removeModel: (model, channelId = null) => {
    if (channelId) {
      // 移除指定渠道的模型
      const compositeKey = setOps.createCompositeKey(channelId, model);
      state.selectedModels = state.selectedModels.filter(m => m.id !== compositeKey);
      delete state.mappings[compositeKey];
    } else {
      // 移除所有渠道的该模型（兼容旧代码）
      state.selectedModels = state.selectedModels.filter(m => m.model !== model);
      // 删除所有包含该模型名的复合键
      for (const key of Object.keys(state.mappings)) {
        if (key.endsWith(`:${model}`)) {
          delete state.mappings[key];
        }
      }
    }
  },

  /**
   * 切换模型选中状态
   * @param {string} model - 模型名称
   * @param {object} channelInfo - 渠道信息 { id, name }
   */
  toggleModel: (model, channelInfo = null) => {
    if (!channelInfo) {
      const selectedChannelIds = Array.from(state.selectedChannels);
      if (selectedChannelIds.length === 0) {
        console.warn(`切换模型 ${model} 时没有选中渠道`);
        return;
      }
      const channelId = selectedChannelIds[0];
      const channel = state.channels.find(c => c.id == channelId);
      channelInfo = {
        id: channelId,
        name: channel?.name || `渠道 ${channelId}`
      };
    }

    const compositeKey = setOps.createCompositeKey(channelInfo.id, model);
    const existingIndex = state.selectedModels.findIndex(m => m.id === compositeKey);

    if (existingIndex > -1) {
      // 已存在，移除
      state.selectedModels.splice(existingIndex, 1);
      delete state.mappings[compositeKey];
    } else {
      // 不存在，添加
      state.selectedModels.push({
        id: compositeKey,
        channelId: channelInfo.id,
        channelName: channelInfo.name,
        model: model
      });
      state.mappings[compositeKey] = {
        id: compositeKey,
        channelId: channelInfo.id,
        channelName: channelInfo.name,
        model: model,
        targetModel: model
      };
    }
  },

  /**
   * 检查模型是否被选中（指定渠道）
   * @param {string} model - 模型名称
   * @param {string|number} channelId - 渠道ID
   * @returns {boolean}
   */
  hasModel: (model, channelId = null) => {
    if (channelId) {
      const compositeKey = setOps.createCompositeKey(channelId, model);
      return state.selectedModels.some(m => m.id === compositeKey);
    }
    // 不传 channelId 时检查是否在任何渠道中被选中（兼容旧代码）
    return state.selectedModels.some(m => m.model === model);
  },

  /**
   * 清空选中模型
   */
  clearModels: () => {
    state.selectedModels = [];
    state.mappings = {};
  },

  /**
   * 获取选中模型数组（返回对象数组，包含渠道信息）
   * @returns {Array} [{ id, channelId, channelName, model, targetModel }]
   */
  getModelsArray: () => {
    // 直接返回 selectedModels 的副本
    // 不再调用 syncSelectedModelsWithMappings，避免可能的递归问题
    return state.selectedModels ? [...state.selectedModels] : [];
  },

  /**
   * 获取纯模型名称数组（兼容旧代码）
   * @returns {Array} [model1, model2, ...]
   */
  getModelNames: () => {
    return state.selectedModels.map(m => m.model);
  },

  /**
   * 获取指定渠道的模型列表
   * @param {string|number} channelId - 渠道ID
   * @returns {Array} 该渠道选中的模型
   */
  getModelsByChannel: (channelId) => {
    return state.selectedModels.filter(m => m.channelId == channelId);
  },

  /**
   * 更新映射目标模型
   * @param {string} model - 源模型名称
   * @param {string} targetModel - 目标模型名称
   * @param {string|number} channelId - 渠道ID
   */
  updateTargetModel: (model, targetModel, channelId) => {
    const compositeKey = setOps.createCompositeKey(channelId, model);
    if (state.mappings[compositeKey]) {
      state.mappings[compositeKey].targetModel = targetModel;
    }
  },

  /**
   * 获取映射目标模型
   * @param {string} model - 源模型名称
   * @param {string|number} channelId - 渠道ID
   * @returns {string}
   */
  getTargetModel: (model, channelId) => {
    const compositeKey = setOps.createCompositeKey(channelId, model);
    return state.mappings[compositeKey]?.targetModel || model;
  },

  // 添加渠道到选中列表
  addChannel: (channelId) => {
    state.selectedChannels.add(channelId);
  },

  // 从选中列表移除渠道
  removeChannel: (channelId) => {
    state.selectedChannels.delete(channelId);
  },

  // 切换渠道选中状态
  toggleChannel: (channelId) => {
    if (state.selectedChannels.has(channelId)) {
      state.selectedChannels.delete(channelId);
    } else {
      state.selectedChannels.add(channelId);
    }
  },

  // 检查渠道是否被选中
  hasChannel: (channelId) => {
    return state.selectedChannels.has(channelId);
  },

  // 清空选中渠道
  clearChannels: () => {
    state.selectedChannels.clear();
  },

  // 获取选中渠道数组
  getChannelsArray: () => {
    return Array.from(state.selectedChannels);
  }
};

/**
 * 同步 selectedModels 和 mappings
 * 确保两者数据一致
 */
export const syncSelectedModelsWithMappings = () => {
  // 1. 检查 mappings 中有但 selectedModels 中没有的模型
  for (const key of Object.keys(state.mappings)) {
    const exists = state.selectedModels.some(m => m.id === key);
    if (!exists) {
      console.warn(`⚠️ 映射 ${key} 在 mappings 中存在但不在 selectedModels 中，添加它`);
      state.selectedModels.push(state.mappings[key]);
    }
  }

  // 2. 检查 selectedModels 中有但 mappings 中没有的模型
  for (const item of state.selectedModels) {
    if (!state.mappings.hasOwnProperty(item.id)) {
      console.warn(`⚠️ 模型 ${item.model} 在 selectedModels 中存在但不在 mappings 中，添加它`);
      state.mappings[item.id] = {
        id: item.id,
        channelId: item.channelId,
        channelName: item.channelName,
        model: item.model,
        targetModel: item.model
      };
    }
  }
};

/**
 * 验证状态一致性
 */
export const validateStateConsistency = () => {
  const issues = [];

  // 检查 selectedModels 和 mappings 数量
  if (state.selectedModels.length !== Object.keys(state.mappings).length) {
    issues.push(`selectedModels (${state.selectedModels.length}) 和 mappings (${Object.keys(state.mappings).length}) 数量不一致`);
  }

  // 检查是否有模型在 selectedModels 中但不在 mappings 中
  for (const item of state.selectedModels) {
    if (!state.mappings.hasOwnProperty(item.id)) {
      issues.push(`模型 ${item.model} (${item.id}) 在 selectedModels 中但不在 mappings 中`);
    }
  }

  // 检查是否有模型在 mappings 中但不在 selectedModels 中
  for (const key of Object.keys(state.mappings)) {
    const exists = state.selectedModels.some(m => m.id === key);
    if (!exists) {
      issues.push(`映射 ${key} 在 mappings 中但不在 selectedModels 中`);
    }
  }

  if (issues.length > 0) {
    console.warn('⚠️ 状态不一致问题:', issues);
    return false;
  }

  return true;
};

export default {
  state,
  modelCache,
  saveState,
  loadState,
  updateState,
  setOps,
  syncSelectedModelsWithMappings,
  validateStateConsistency
};

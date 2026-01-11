/**
 * 状态管理模块
 * 集中管理应用状态
 */
import { DEFAULT_CONFIG, CACHE_CONFIG, STORAGE_KEYS } from './constants.js';

// 主状态
export const state = {
  // 配置
  config: { ...DEFAULT_CONFIG },

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
  // 添加模型到选中列表
  addModel: (model, channelInfo = null) => {
    if (!state.selectedModels.includes(model)) {
      state.selectedModels.push(model);
      // 同时记录渠道信息，避免"未知渠道"问题
      if (channelInfo) {
        state.modelChannelMap[model] = channelInfo;
      } else if (!state.modelChannelMap[model]) {
        // 如果没有传入渠道信息，尝试从现有数据中查找
        console.warn(`添加模型 ${model} 时未提供渠道信息`);
      }
    }
    // 确保 mappings 中有该模型
    if (!state.mappings.hasOwnProperty(model)) {
      state.mappings[model] = model;
    }
  },

  // 从选中列表移除模型
  removeModel: (model) => {
    state.selectedModels = state.selectedModels.filter(m => m !== model);
    // 同时清理相关状态
    delete state.mappings[model];
    delete state.modelChannelMap[model];
  },

  // 切换模型选中状态
  toggleModel: (model) => {
    const index = state.selectedModels.indexOf(model);
    if (index > -1) {
      state.selectedModels.splice(index, 1);
      delete state.mappings[model];
      delete state.modelChannelMap[model];
    } else {
      state.selectedModels.push(model);
      if (!state.mappings.hasOwnProperty(model)) {
        state.mappings[model] = model;
      }
    }
  },

  // 检查模型是否被选中
  hasModel: (model) => {
    return state.selectedModels.includes(model);
  },

  // 清空选中模型
  clearModels: () => {
    state.selectedModels = [];
    // 同时清理关联的映射和渠道信息
    state.mappings = {};
    state.modelChannelMap = {};
  },

  // 获取选中模型数组（自动同步）
  getModelsArray: () => {
    // 返回前确保数据一致性
    syncSelectedModelsWithMappings();
    return [...state.selectedModels];
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
  const mappingsKeys = Object.keys(state.mappings);
  const selectedModelsSet = new Set(state.selectedModels);

  // 1. 检查 mappings 中有但 selectedModels 中没有的模型
  for (const model of mappingsKeys) {
    if (!selectedModelsSet.has(model)) {
      console.warn(`⚠️ 模型 ${model} 在 mappings 中存在但不在 selectedModels 中，添加它`);
      state.selectedModels.push(model);
    }
  }

  // 2. 检查 selectedModels 中有但 mappings 中没有的模型
  for (const model of state.selectedModels) {
    if (!state.mappings.hasOwnProperty(model)) {
      console.warn(`⚠️ 模型 ${model} 在 selectedModels 中存在但不在 mappings 中，添加它`);
      state.mappings[model] = model;
    }
  }

  // 3. 检查 modelChannelMap 是否完整
  for (const model of state.selectedModels) {
    if (!state.modelChannelMap.hasOwnProperty(model)) {
      console.warn(`⚠️ 模型 ${model} 缺少渠道信息`);
    }
  }
};

/**
 * 验证状态一致性
 */
export const validateStateConsistency = () => {
  const issues = [];

  // 检查 selectedModels 和 mappings 长度
  if (state.selectedModels.length !== Object.keys(state.mappings).length) {
    issues.push(`selectedModels (${state.selectedModels.length}) 和 mappings (${Object.keys(state.mappings).length}) 长度不一致`);
  }

  // 检查是否有模型在 selectedModels 中但不在 mappings 中
  for (const model of state.selectedModels) {
    if (!state.mappings.hasOwnProperty(model)) {
      issues.push(`模型 ${model} 在 selectedModels 中但不在 mappings 中`);
    }
  }

  // 检查是否有模型在 mappings 中但不在 selectedModels 中
  for (const model of Object.keys(state.mappings)) {
    if (!state.selectedModels.includes(model)) {
      issues.push(`模型 ${model} 在 mappings 中但不在 selectedModels 中`);
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

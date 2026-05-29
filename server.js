const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const NewAPIClient = require('./lib/NewAPIClient');
const sharedModelCache = require('./lib/sharedModelCache');
const { getInstance: getMonitor } = require('./lib/ScheduledMonitor');

const app = express();
const PORT = process.env.PORT || 8083;
const CONFIG_DIR = process.env.CONFIG_DIR
  ? path.resolve(process.env.CONFIG_DIR)
  : __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MONITOR_CONFIG_FILE = path.join(CONFIG_DIR, 'monitor-config.json');
const DEFAULT_SECRET_KEY = 'newapi-sync-tool-2024';
const SECRET_KEY = process.env.SECRET_KEY || DEFAULT_SECRET_KEY;
const USING_DEFAULT_SECRET = SECRET_KEY === DEFAULT_SECRET_KEY;

// Startup timestamp
const startTime = Date.now();

// One-click update jobs (in-memory)
const oneClickJobs = new Map(); // jobId -> job
const ONE_CLICK_JOB_TTL_MS = 30 * 60 * 1000; // 30 min
const ONE_CLICK_JOB_MAX_LOGS = 2000;

// Sync checkpoints (in-memory)
const syncCheckpoints = new Map(); // checkpointId -> snapshot
const CHECKPOINT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CHECKPOINT_MAX = 20;
let latestCheckpointId = null;

const ensureConfigDir = async () => {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
};

const createJobId = () => {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const createCheckpointId = () => {
  return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const cleanupExpiredJobs = () => {
  const now = Date.now();
  for (const [jobId, job] of oneClickJobs.entries()) {
    if (!job) {
      oneClickJobs.delete(jobId);
      continue;
    }
    const base = job.finishedAt || job.startedAt || job.createdAt || 0;
    if (base && now - base > ONE_CLICK_JOB_TTL_MS) {
      oneClickJobs.delete(jobId);
    }
  }
};

const cleanupExpiredCheckpoints = () => {
  const now = Date.now();
  for (const [checkpointId, checkpoint] of syncCheckpoints.entries()) {
    if (!checkpoint) {
      syncCheckpoints.delete(checkpointId);
      continue;
    }
    const createdAt = checkpoint.createdAt || 0;
    if (createdAt && now - createdAt > CHECKPOINT_TTL_MS) {
      syncCheckpoints.delete(checkpointId);
    }
  }

  if (syncCheckpoints.size > CHECKPOINT_MAX) {
    const ordered = Array.from(syncCheckpoints.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const removeCount = Math.max(0, ordered.length - CHECKPOINT_MAX);
    for (let i = 0; i < removeCount; i++) {
      syncCheckpoints.delete(ordered[i].id);
    }
  }

  if (latestCheckpointId && !syncCheckpoints.has(latestCheckpointId)) {
    const newest = Array.from(syncCheckpoints.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    latestCheckpointId = newest ? newest.id : null;
  }
};

const normalizeBaseUrl = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');

const cleanToken = (token) => String(token || '').trim().replace(/[\n\r\t]/g, '');

const resolveAuthHeaderType = (authHeaderType) => {
  const mapping = {
    NEW_API: 'New-Api-User',
    VELOERA: 'Veloera-User'
  };
  const key = String(authHeaderType || 'NEW_API').toUpperCase();
  return mapping[key] || mapping.NEW_API;
};

const runWithConcurrency = async (items, concurrency, worker) => {
  const results = new Array(items.length);
  let index = 0;
  const workerCount = Math.min(concurrency, items.length);

  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
};

const fetchAllChannels = async (client, pageSize = 1000) => {
  const parsedPageSize = Number(pageSize);
  const safePageSize = Number.isFinite(parsedPageSize) && parsedPageSize > 0
    ? Math.max(1, Math.min(1000, Math.floor(parsedPageSize)))
    : 1000;

  const firstPage = await client.getChannels(1, safePageSize);
  if (!firstPage.success) {
    return firstPage;
  }

  let channels = Array.isArray(firstPage.data) ? firstPage.data : [];
  const total = Number(firstPage.total) || channels.length;

  if (total > channels.length) {
    const totalPages = Math.ceil(total / safePageSize);
    for (let page = 2; page <= totalPages; page += 1) {
      const pageResult = await client.getChannels(page, safePageSize);
      if (!pageResult.success) {
        return pageResult;
      }
      if (Array.isArray(pageResult.data)) {
        channels = channels.concat(pageResult.data);
      }
    }
  }

  return {
    success: true,
    data: channels,
    total: channels.length,
    page: 1
  };
};

const collectChannelIds = async (context, channelIds) => {
  if (Array.isArray(channelIds) && channelIds.length > 0) {
    return Array.from(new Set(channelIds.map(id => String(id)).filter(Boolean)));
  }

  const client = new NewAPIClient({
    baseUrl: context.baseUrl,
    token: context.token,
    userId: context.userId,
    authHeaderType: context.authHeaderType
  });

  const channelsResult = await fetchAllChannels(client, 1000);
  if (!channelsResult.success) {
    throw new Error(`Failed to fetch channels: ${channelsResult.message}`);
  }

  const channels = Array.isArray(channelsResult.data) ? channelsResult.data : [];
  return Array.from(new Set(channels.map(ch => String(ch.id)).filter(Boolean)));
};

const fetchChannelDetail = async (context, channelId) => {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const url = `${baseUrl}/api/channel/${channelId}`;
  const headers = {
    Authorization: `Bearer ${context.token}`,
    'Content-Type': 'application/json',
    [resolveAuthHeaderType(context.authHeaderType)]: context.userId
  };
  const response = await axios.get(url, { headers, timeout: 15000 });
  const data = response?.data?.data;
  if (!data) {
    throw new Error(`Invalid channel detail response: ${channelId}`);
  }
  if (data.id == null) {
    data.id = channelId;
  }
  return data;
};

const normalizeModels = (models) => {
  if (Array.isArray(models)) {
    return models.map(m => String(m).trim()).filter(Boolean).join(',');
  }
  if (models == null) return '';
  return String(models);
};

const normalizeModelMapping = (modelMapping) => {
  if (modelMapping == null) return null;
  if (typeof modelMapping === 'string') {
    const trimmed = modelMapping.trim();
    return trimmed ? trimmed : null;
  }
  try {
    return JSON.stringify(modelMapping);
  } catch (error) {
    return null;
  }
};

const buildChannelUpdatePayload = (channelData) => {
  return {
    id: channelData.id,
    models: normalizeModels(channelData.models),
    status: channelData.status ?? 1,
    type: channelData.type ?? 1,
    test_model: channelData.test_model ?? 'gpt-3.5-turbo',
    base_url: channelData.base_url ?? '',
    key: channelData.key ?? '',
    name: channelData.name ?? '',
    weight: channelData.weight ?? 0,
    model_mapping: normalizeModelMapping(channelData.model_mapping),
    ...(channelData.priority !== undefined && { priority: channelData.priority }),
    ...(channelData.auto_ban !== undefined && { auto_ban: channelData.auto_ban }),
    ...(channelData.tag !== undefined && { tag: channelData.tag }),
    ...(channelData.group !== undefined && { group: channelData.group })
  };
};

const updateChannelSnapshot = async (context, channelData) => {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const url = `${baseUrl}/api/channel/`;
  const headers = {
    Authorization: `Bearer ${context.token}`,
    'Content-Type': 'application/json',
    [resolveAuthHeaderType(context.authHeaderType)]: context.userId
  };
  const payload = buildChannelUpdatePayload(channelData);
  await axios.put(url, payload, { headers, timeout: 20000 });
};

// Middlewares
// CORS: restrict to an explicit allowlist when ALLOWED_ORIGINS is set
// (comma-separated). Defaults to the previous permissive behaviour so existing
// deployments are unaffected, but exposing the API publicly should set this.
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors(allowedOrigins.length > 0
  ? {
    origin: (origin, callback) => {
      // Allow same-origin / non-browser requests (no Origin header)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    }
  }
  : undefined));

app.use(express.json({ charset: 'utf-8' }));
app.use(express.urlencoded({ extended: true, charset: 'utf-8' }));
app.use(express.static(path.join(__dirname, 'public')));

// 设置响应头确保 UTF-8 编码
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Simple request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Read and decrypt the persisted config (returns null when absent/invalid).
const getStoredConfig = async () => {
  try {
    const configData = await fs.readFile(CONFIG_FILE, 'utf8');
    const encrypted = JSON.parse(configData);
    return NewAPIClient.decryptConfig(encrypted, SECRET_KEY);
  } catch (error) {
    return null;
  }
};

// Credential fallback: the access token is only ever persisted server-side
// (AES-encrypted in config.json). The browser sends requests without a token,
// and we fill it in from the stored config here. The stored token is injected
// only when the request targets the same baseUrl it was saved for, so it can
// never be leaked to a different server supplied by the client.
app.use(async (req, res, next) => {
  if (req.method === 'GET') return next();
  if (!req.path.startsWith('/api/')) return next();
  // /api/config saves credentials (needs the real token in the body) and
  // /api/monitor/* uses its own stored config — skip both.
  if (req.path === '/api/config' || req.path.startsWith('/api/monitor')) return next();

  const src = req.body;
  if (!src || typeof src !== 'object') return next();

  const hasToken = src.token != null && String(src.token).trim() !== '';
  if (hasToken) return next();

  try {
    const stored = await getStoredConfig();
    if (!stored || !stored.token) return next();

    // Only inject the stored token for its own server.
    if (src.baseUrl && normalizeBaseUrl(src.baseUrl) !== normalizeBaseUrl(stored.baseUrl)) {
      return next();
    }

    if (!src.baseUrl) src.baseUrl = stored.baseUrl;
    if (!src.userId) src.userId = stored.userId;
    if (src.authHeaderType == null && stored.authHeaderType) src.authHeaderType = stored.authHeaderType;
    src.token = stored.token;
  } catch (error) {
    // Fall through with whatever the client supplied.
  }

  next();
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Status endpoint (for frontend compatibility)
app.get('/api/status', async (req, res) => {
  try {
    res.json({
      success: true,
      message: '服务器正常运行',
      data: {
        version: '4.0.0',
        timestamp: new Date().toISOString(),
        uptime: Math.floor((Date.now() - startTime) / 1000)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '状态检查失败', error: error.message });
  }
});

// Channel list endpoint (GET for frontend compatibility)
app.get('/api/channel/', async (req, res) => {
  try {
    let { baseUrl, token, userId, authHeaderType } = req.query;
    // Fall back to the stored, server-side encrypted token when absent.
    if (!token) {
      const stored = await getStoredConfig();
      if (stored && stored.token && (!baseUrl || normalizeBaseUrl(baseUrl) === normalizeBaseUrl(stored.baseUrl))) {
        baseUrl = baseUrl || stored.baseUrl;
        userId = userId || stored.userId;
        authHeaderType = authHeaderType || stored.authHeaderType;
        token = stored.token;
      }
    }
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    const client = new NewAPIClient({ baseUrl, token, userId, authHeaderType });
    const requestedPageSize = req.query.pageSize || req.query.page_size;
    const result = await fetchAllChannels(client, requestedPageSize || 1000);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: '获取渠道失败', error: error.message });
  }
});

// Health (enhanced)
app.get('/api/health', (req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const memoryUsage = process.memoryUsage();

  res.json({
    success: true,
    message: '服务器正常运行',
    timestamp: new Date().toISOString(),
    version: '4.0.0',
    uptime,
    memory: {
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
    },
    nodeVersion: process.version,
    platform: process.platform,
  });
});

// Config management
app.get('/api/config', async (req, res) => {
  try {
    const configData = await fs.readFile(CONFIG_FILE, 'utf8');
    const encrypted = JSON.parse(configData);
    const config = NewAPIClient.decryptConfig(encrypted, SECRET_KEY);

    const safeConfig = {
      baseUrl: config.baseUrl,
      userId: config.userId,
      hasConfig: true,
    };

    res.json({ success: true, config: safeConfig });
  } catch (error) {
    res.json({ success: true, config: { hasConfig: false } });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    const { baseUrl, token, userId } = req.body;
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    const config = { baseUrl, token, userId };
    const encrypted = NewAPIClient.encryptConfig(config, SECRET_KEY);
    await ensureConfigDir();
    await fs.writeFile(CONFIG_FILE, JSON.stringify(encrypted, null, 2), 'utf8');

    res.json({ success: true, message: '配置保存成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: '配置保存失败', error: error.message });
  }
});

// Connection test
app.post('/api/test-connection', async (req, res) => {
  try {
    const { baseUrl, token, userId, quickTest, authHeaderType } = req.body;
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    const client = new NewAPIClient({ baseUrl, token, userId, authHeaderType });
    const result = quickTest ? await client.quickConnectionTest() : await client.testConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: '连接测试失败', error: error.message });
  }
});

// Channels list
app.post('/api/channels', async (req, res) => {
  try {
    const { baseUrl, token, userId, authHeaderType, pageSize } = req.body;
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }
    const client = new NewAPIClient({ baseUrl, token, userId, authHeaderType });
    const result = await fetchAllChannels(client, pageSize || 1000);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: '获取渠道失败', error: error.message });
  }
});

// Sync models
app.post('/api/sync-models', async (req, res) => {
  try {
    const { baseUrl, token, userId, modelMapping, authHeaderType, modelUpdateMode, channelIds } = req.body;

    console.log('📊 收到同步请求:');
    console.log('- modelMapping keys数量:', Object.keys(modelMapping || {}).length);
    console.log('- modelMapping前5个:', Object.entries(modelMapping || {}).slice(0, 5));
    console.log('- modelUpdateMode:', modelUpdateMode || 'append');
    console.log('- 指定渠道数量:', channelIds ? channelIds.length : '未指定（同步所有渠道）');

    if (!baseUrl || !token || !userId || !modelMapping) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }
    const client = new NewAPIClient({ baseUrl, token, userId, authHeaderType });
    const result = await client.syncModels(modelMapping, modelUpdateMode || 'append', channelIds);

    console.log('✅ 同步完成, 结果:', {
      success: result.success,
      stats: result.stats
    });

    res.json(result);
  } catch (error) {
    console.error('❌ 同步失败:', error);
    res.status(500).json({ success: false, message: '模型同步失败', error: error.message });
  }
});

// Create sync checkpoint
app.post('/api/checkpoint/create', async (req, res) => {
  try {
    cleanupExpiredCheckpoints();

    const { baseUrl, token, userId, authHeaderType, channelIds, tag, concurrency } = req.body || {};
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    const context = {
      baseUrl: normalizeBaseUrl(baseUrl),
      token: cleanToken(token),
      userId,
      authHeaderType: authHeaderType || 'NEW_API'
    };

    const resolvedIds = await collectChannelIds(context, channelIds);
    if (!resolvedIds || resolvedIds.length === 0) {
      return res.json({ success: false, message: '无可创建检查点的渠道' });
    }

    const concurrencyRaw = Number(concurrency);
    const workerCount = Number.isFinite(concurrencyRaw)
      ? Math.max(1, Math.min(10, Math.floor(concurrencyRaw)))
      : 6;

    const snapshots = [];
    const errors = [];

    await runWithConcurrency(resolvedIds, workerCount, async (channelId) => {
      try {
        const detail = await fetchChannelDetail(context, channelId);
        snapshots.push({
          id: detail.id,
          name: detail.name,
          models: detail.models,
          model_mapping: detail.model_mapping,
          status: detail.status,
          type: detail.type,
          test_model: detail.test_model,
          base_url: detail.base_url,
          key: detail.key,
          weight: detail.weight,
          priority: detail.priority,
          auto_ban: detail.auto_ban,
          tag: detail.tag,
          group: detail.group
        });
      } catch (e) {
        errors.push({ channelId: String(channelId), error: e.message });
      }
    });

    if (snapshots.length === 0) {
      return res.json({ success: false, message: '检查点创建失败，未成功获取任何渠道', errors });
    }

    const checkpointId = createCheckpointId();
    const checkpoint = {
      id: checkpointId,
      createdAt: Date.now(),
      count: snapshots.length,
      channelIds: snapshots.map(snapshot => String(snapshot.id)),
      baseUrl: context.baseUrl,
      userId: String(context.userId),
      authHeaderType: context.authHeaderType || 'NEW_API',
      tag: tag ? String(tag).trim() : null,
      data: snapshots
    };

    syncCheckpoints.set(checkpointId, checkpoint);
    latestCheckpointId = checkpointId;
    cleanupExpiredCheckpoints();

    res.json({
      success: true,
      checkpointId,
      createdAt: checkpoint.createdAt,
      count: checkpoint.count,
      failed: errors.length,
      errors
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '创建检查点失败', error: error.message });
  }
});

// Restore sync checkpoint
app.post('/api/checkpoint/restore', async (req, res) => {
  try {
    cleanupExpiredCheckpoints();

    const { baseUrl, token, userId, authHeaderType, checkpointId, concurrency } = req.body || {};
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    const resolvedId = checkpointId || latestCheckpointId;
    if (!resolvedId) {
      return res.status(404).json({ success: false, message: '未找到可用的检查点' });
    }

    const checkpoint = syncCheckpoints.get(resolvedId);
    if (!checkpoint) {
      return res.status(404).json({ success: false, message: '检查点不存在或已过期' });
    }

    const context = {
      baseUrl: normalizeBaseUrl(baseUrl),
      token: cleanToken(token),
      userId,
      authHeaderType: authHeaderType || 'NEW_API'
    };

    if (checkpoint.baseUrl && normalizeBaseUrl(checkpoint.baseUrl) !== context.baseUrl) {
      return res.status(400).json({ success: false, message: '检查点与当前服务器不一致，已取消回退' });
    }
    if (checkpoint.userId && String(checkpoint.userId) !== String(context.userId)) {
      return res.status(400).json({ success: false, message: '检查点与当前用户不一致，已取消回退' });
    }

    const snapshots = Array.isArray(checkpoint.data) ? checkpoint.data : [];
    if (snapshots.length === 0) {
      return res.json({ success: false, message: '检查点无可回退数据' });
    }

    const concurrencyRaw = Number(concurrency);
    const workerCount = Number.isFinite(concurrencyRaw)
      ? Math.max(1, Math.min(10, Math.floor(concurrencyRaw)))
      : 6;

    const errors = [];
    let restored = 0;

    await runWithConcurrency(snapshots, workerCount, async (snapshot) => {
      try {
        await updateChannelSnapshot(context, snapshot);
        restored += 1;
      } catch (e) {
        errors.push({ channelId: String(snapshot.id), error: e.message });
      }
    });

    res.json({
      success: restored > 0,
      checkpointId: resolvedId,
      restored,
      failed: errors.length,
      errors,
      message: restored > 0 ? '回退完成' : '回退失败'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '回退检查点失败', error: error.message });
  }
});

// Get latest checkpoint
app.get('/api/checkpoint/latest', (req, res) => {
  cleanupExpiredCheckpoints();
  if (!latestCheckpointId || !syncCheckpoints.has(latestCheckpointId)) {
    return res.json({ success: false, message: '无可用的检查点' });
  }
  const checkpoint = syncCheckpoints.get(latestCheckpointId);
  res.json({
    success: true,
    checkpoint: {
      id: checkpoint.id,
      createdAt: checkpoint.createdAt,
      count: checkpoint.count,
      channelIds: checkpoint.channelIds,
      tag: checkpoint.tag
    }
  });
});

// Channel models (prefer fetch_models, fallback)
app.post('/api/channel-models', async (req, res) => {
  try {
    const { baseUrl, token, userId, channelId, authHeaderType, fetchAll = true, includeDisabled = true, fetchSelectedOnly = false, fetchChannelConfig = false, forceRefresh = false } = req.body;
    if (!baseUrl || !token || !userId || !channelId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    const cleanToken = String(token).trim().replace(/[\n\r\t]/g, '');
    const resolvedAuthHeaderType = authHeaderType || 'NEW_API';

    // 如果是获取渠道配置（用于重定向检查）
    if (fetchChannelConfig) {
      const channelUrl = `${baseUrl.replace(/\/+$/, '')}/api/channel/${channelId}`;
      console.log(`[DEBUG] 获取渠道详细配置: ${channelUrl}`);

      try {
        const response = await axios.get(channelUrl, {
          headers: {
            Authorization: `Bearer ${cleanToken}`,
            'New-Api-User': userId,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        });

        const data = response.data;
        if (data && data.data) {
          console.log(`[DEBUG] 成功获取渠道配置，包含模型映射: ${!!data.data.model_mapping}`);
          res.json({
            success: true,
            data: {
              id: channelId,
              name: data.data.name || `渠道 ${channelId}`,
              model_mapping: data.data.model_mapping || {},
              models: data.data.models,
              status: data.data.status
            },
            message: '成功获取渠道详细配置'
          });
          return;
        }
        console.log('[DEBUG] 渠道配置响应无有效数据');
      } catch (e) {
        console.log(`[DEBUG] 获取渠道配置失败: ${e.message}`);
      }

      res.json({ success: false, message: '无法获取渠道详细配置' });
      return;
    }

    // 如果是获取已选择的模型，使用不同的端点
    if (fetchSelectedOnly) {
      const selectedUrl = `${baseUrl.replace(/\/+$/, '')}/api/channel/${channelId}`;
      console.log(`[DEBUG] 获取已选择的模型: ${selectedUrl}`);
      
      try {
        const response = await axios.get(selectedUrl, {
          headers: {
            Authorization: `Bearer ${cleanToken}`,
            'New-Api-User': userId,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        });

        const data = response.data;
        if (data && data.data && data.data.models) {
          // 处理已选择的模型
          let selectedModels = [];
          if (typeof data.data.models === 'string') {
            selectedModels = data.data.models.split(',').map(m => m.trim()).filter(m => m);
          } else if (Array.isArray(data.data.models)) {
            selectedModels = data.data.models;
          }
          
          console.log(`[DEBUG] 成功获取 ${selectedModels.length} 个已选择的模型:`, selectedModels.slice(0, 5));
          res.json({ success: true, data: selectedModels, message: `成功获取 ${selectedModels.length} 个已选择的模型` });
          return;
        }
      } catch (e) {
        console.log(`[DEBUG] 获取已选择模型失败: ${e.message}`);
        // 如果获取已选择模型失败，返回空数组
        res.json({ success: true, data: [], message: '未找到已选择的模型' });
        return;
      }
    }
    
    const cacheContext = { baseUrl, token: cleanToken, userId, authHeaderType: resolvedAuthHeaderType, channelId };
    if (forceRefresh) {
      sharedModelCache.deleteProviderModels(cacheContext);
    } else {
      const cached = sharedModelCache.getProviderModels(cacheContext);
      if (cached && cached.length > 0) {
        console.log(`[DEBUG] 使用共享缓存获取 ${cached.length} 个模型`);
        res.json({ success: true, data: cached, message: `从缓存获取 ${cached.length} 个模型`, source: 'shared-cache' });
        return;
      }
    }

    const client = new NewAPIClient({ baseUrl, token: cleanToken, userId, authHeaderType: resolvedAuthHeaderType });
    const providerResult = await client.fetchActualProviderModels(channelId, { forceRefresh: Boolean(forceRefresh) });
    if (providerResult && providerResult.success) {
      const models = Array.isArray(providerResult.data) ? providerResult.data : [];
      res.json({ success: true, data: models, message: `成功获取 ${models.length} 个模型`, source: providerResult.source || 'fetch_models' });
      return;
    }

    const result = await client.getChannelModels(channelId, Boolean(forceRefresh));
    res.json(result);
  } catch (error) {
    console.error(`[ERROR] 获取渠道模型失败: ${error.message}`);
    res.status(500).json({ success: false, message: '获取渠道模型失败', error: error.message });
  }
});

// Channel detail (for redirect checking)
app.post('/api/channel-detail', async (req, res) => {
  try {
    const { baseUrl, token, userId, channelId, authHeaderType } = req.body;
    if (!baseUrl || !token || !userId || !channelId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    const cleanToken = String(token).trim().replace(/[\n\r\t]/g, '');
    const channelUrl = `${baseUrl.replace(/\/+$/, '')}/api/channel/${channelId}`;
    console.log(`[DEBUG] 获取渠道详细配置: ${channelUrl}`);

    try {
      const response = await axios.get(channelUrl, {
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          'New-Api-User': userId,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      const data = response.data;
      if (data && data.data) {
        console.log(`[DEBUG] 成功获取渠道配置，包含模型映射: ${!!data.data.model_mapping}`);
        res.json({
          success: true,
          data: {
            id: channelId,
            name: data.data.name || `渠道 ${channelId}`,
            model_mapping: data.data.model_mapping || {},
            // 其他可能的配置字段
            models: data.data.models,
            status: data.data.status
          },
          message: '成功获取渠道详细配置'
        });
        return;
      }
      console.log('[DEBUG] 渠道配置响应无有效数据');
    } catch (e) {
      console.log(`[DEBUG] 获取渠道配置失败: ${e.message}`);
    }

    res.json({ success: false, message: '无法获取渠道详细配置' });
  } catch (error) {
    console.error(`[ERROR] 获取渠道详细配置失败: ${error.message}`);
    res.status(500).json({ success: false, message: '获取渠道详细配置失败', error: error.message });
  }
});

// Global models
app.post('/api/global-models', async (req, res) => {
  try {
    const { baseUrl, token, userId, authHeaderType } = req.body;
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }
    const client = new NewAPIClient({ baseUrl, token, userId, authHeaderType });
    const result = await client.getAllModels();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: '获取全局模型失败', error: error.message });
  }
});

// Debug API endpoints
app.post('/api/debug-api', async (req, res) => {
  try {
    const { baseUrl, token, userId, authHeaderType } = req.body;
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }
    const client = new NewAPIClient({ baseUrl, token, userId, authHeaderType });
    const result = await client.debugAPIEndpoints();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: 'API 调试失败', error: error.message });
  }
});

// One-click update models - 一键更新模型
app.post('/api/one-click-update', async (req, res) => {
  try {
    const { baseUrl, token, userId, authHeaderType, channelIds, dryRun, options = {} } = req.body;
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    console.log('🚀 收到一键更新请求:');
    console.log('- 指定渠道:', channelIds ? channelIds.length : '全部');
    console.log('- 预览模式:', dryRun ? '是' : '否');

    const client = new NewAPIClient({ baseUrl, token, userId, authHeaderType, debug: Boolean(options.debug) });
    const result = dryRun
      ? await client.previewOneClickUpdate(channelIds, options)
      : await client.oneClickUpdateModels(channelIds, options);

    console.log('✅ 一键更新完成:', {
      success: result.success,
      scanned: result.results?.scannedChannels,
      updated: result.results?.updatedChannels,
      fixed: result.results?.fixedMappings
    });

    res.json(result);
  } catch (error) {
    console.error('❌ 一键更新失败:', error);
    res.status(500).json({ success: false, message: '一键更新失败', error: error.message });
  }
});

// Preview one-click update - 预览一键更新
app.post('/api/preview-one-click-update', async (req, res) => {
  try {
    const { baseUrl, token, userId, authHeaderType, channelIds, options = {} } = req.body;
    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    console.log('🔍 收到一键更新预览请求');

    const client = new NewAPIClient({ baseUrl, token, userId, authHeaderType, debug: Boolean(options.debug) });
    const result = await client.previewOneClickUpdate(channelIds, options);

    console.log('✅ 预览完成:', {
      brokenMappings: result.results?.brokenMappings?.length || 0,
      newMappings: result.results?.newMappings?.length || 0
    });

    res.json(result);
  } catch (error) {
    console.error('❌ 预览失败:', error);
    res.status(500).json({ success: false, message: '预览失败', error: error.message });
  }
});

// ==================== One-click update job APIs ====================

// Start a one-click preview/update job (async)
app.post('/api/one-click-update-job', async (req, res) => {
  try {
    cleanupExpiredJobs();

    const {
      baseUrl,
      token,
      userId,
      authHeaderType,
      channelIds,
      dryRun = true,
      fromPreviewJobId,
      options = {},
      rules = null,  // 用户规则参数
      selectedMappings = null  // 新增：选中的映射列表
    } = req.body || {};

    if (!baseUrl || !token || !userId) {
      return res.status(400).json({ success: false, message: '请填写完整的配置信息' });
    }

    // 日志记录规则信息
    if (rules) {
      console.log('📋 收到用户规则:');
      console.log('- 名称匹配规则:', rules.nameMatch?.length || 0);
      console.log('- 合并规则:', rules.merge?.length || 0);
      console.log('- 自定义规则:', rules.custom?.length || 0);
    }

    const jobId = createJobId();
    const createdAt = Date.now();

    const job = {
      id: jobId,
      type: dryRun ? 'preview' : 'execute',
      sourcePreviewJobId: fromPreviewJobId || null,
      createdAt,
      startedAt: Date.now(),
      finishedAt: null,
      cancelled: false,
      status: 'running', // running | completed | failed | cancelled
      message: '',
      progress: { current: 0, total: 0, percent: 0, stage: dryRun ? 'preview' : 'execute' },
      logs: [],
      results: null,
      error: null
    };

    const appendLog = (msg, type = 'info') => {
      const entry = { ts: Date.now(), type, msg: String(msg ?? '') };
      job.logs.push(entry);
      if (job.logs.length > ONE_CLICK_JOB_MAX_LOGS) {
        job.logs.splice(0, job.logs.length - ONE_CLICK_JOB_MAX_LOGS);
      }
    };

    oneClickJobs.set(jobId, job);

    // Fire and forget async work
    (async () => {
      try {
        const client = new NewAPIClient({ baseUrl, token, userId, authHeaderType, debug: Boolean(options.debug) });

        const runOptions = {
          ...options,
          rules,  // 传递用户规则
          onLog: (msg, type) => appendLog(msg, type),
          onProgress: (p) => { job.progress = { ...job.progress, ...p }; },
          shouldAbort: () => job.cancelled
        };

        const runExecuteFromPreview = async (previewJobId, selectedMappingsOverride = null) => {
          const previewJob = oneClickJobs.get(previewJobId);
          if (!previewJob) {
            throw new Error('预览任务不存在或已过期，请重新预览');
          }
          if (previewJob.type !== 'preview') {
            throw new Error('fromPreviewJobId 必须指向预览任务');
          }
          if (previewJob.status !== 'completed') {
            if (previewJob.status === 'running') {
              throw new Error('预览任务尚未完成，请等待预览结束后再执行');
            }
            throw new Error(`预览任务未成功完成（状态: ${previewJob.status}），请重新预览`);
          }

          const previewResults = previewJob.results || {};
          const onlyEnabled = runOptions.onlyEnabled !== false;

          const channelIdsFilter = Array.isArray(channelIds) && channelIds.length > 0
            ? new Set(channelIds.map(id => String(id)))
            : null;

          const normalizeMappings = (list) => {
            if (!Array.isArray(list)) return [];
            return list
              .filter(m => m && m.channelId != null)
              .filter(m => !channelIdsFilter || channelIdsFilter.has(String(m.channelId)));
          };

          // 如果传入了选中的映射，使用选中的映射；否则使用预览结果中的所有映射
          const newMappingsAll = selectedMappingsOverride && Array.isArray(selectedMappingsOverride) && selectedMappingsOverride.length > 0
            ? normalizeMappings(selectedMappingsOverride)
            : normalizeMappings(previewResults.newMappings);
          const brokenMappingsAll = normalizeMappings(previewResults.brokenMappings);

          const channelToMappings = new Map();
          for (const item of newMappingsAll) {
            const channelIdStr = String(item.channelId);
            const standardName = String(item.standardName ?? '').trim();
            const actualName = item.actualName == null ? null : String(item.actualName).trim();
            const originalModel = String(item.originalModel ?? '').trim();
            const fixType = typeof item.fixType === 'string' ? item.fixType.trim() : '';
            const sourceStandard = typeof item.sourceStandard === 'string' ? item.sourceStandard.trim() : '';
            const isRemoval = Boolean(item.action === 'delete' || item.removeModel || fixType === 'remove-invalid');
            const dedupeKey = (originalModel || standardName || actualName).toLowerCase();
            if (!dedupeKey || (!actualName && !isRemoval)) continue;

            const existing = channelToMappings.get(channelIdStr) || new Map();
            // Deduplicate per channel by old model (originalModel), last write wins
            existing.set(dedupeKey, {
              standardName,
              actualName,
              originalModel,
              confidence: item.confidence,
              method: item.method,
              fixType,
              sourceStandard,
              action: item.action,
              removeModel: Boolean(item.removeModel)
            });
            channelToMappings.set(channelIdStr, existing);
          }

          const targetChannelIds = Array.from(channelToMappings.keys());
          const total = targetChannelIds.length;
          let processed = 0;

          const results = {
            scannedChannels: Number(previewResults.scannedChannels || 0),
            updatedChannels: 0,
            fixedMappings: 0,
            brokenMappings: brokenMappingsAll,
            newMappings: newMappingsAll,
            errors: []
          };

          runOptions.onProgress?.({ stage: 'execute', current: 0, total, percent: 0 });

          if (total === 0) {
            appendLog('✅ 无需执行：预览结果中没有可修复映射', 'success');
            return {
              success: true,
              message: '无需更新',
              results
            };
          }

          appendLog(`⚡ 执行将复用预览结果（渠道数: ${total}），无需重新扫描 fetch_models`, 'info');

          const channelsResult = await client.getChannels(1, 1000);
          if (!channelsResult.success) {
            throw new Error(`获取渠道失败: ${channelsResult.message}`);
          }
          const channels = channelsResult.data || [];
          const channelsById = new Map(channels.map(ch => [String(ch.id), ch]));

          const maxConcurrencyRaw = Number(runOptions.concurrency ?? runOptions.maxConcurrency);
          const maxConcurrency = Number.isFinite(maxConcurrencyRaw)
            ? Math.max(1, Math.min(10, Math.floor(maxConcurrencyRaw)))
            : 4;

          let nextIndex = 0;
          const worker = async () => {
            while (true) {
              if (job.cancelled) return;

              const index = nextIndex;
              nextIndex++;
              if (index >= total) return;

              const channelIdStr = targetChannelIds[index];
              const mappingMap = channelToMappings.get(channelIdStr);
              const mappingList = mappingMap ? Array.from(mappingMap.values()) : [];

              const channel = channelsById.get(channelIdStr);
              const channelName = channel?.name || channelIdStr;

              try {
                if (!channel) {
                  results.errors.push({ channelId: channelIdStr, channelName, error: '渠道不存在' });
                  appendLog(`⚠️ 渠道 ${channelIdStr} 不存在，跳过`, 'warning');
                  continue;
                }

                if (onlyEnabled && channel.status !== 1) {
                  appendLog(`⏭️ 渠道 "${channelName}" 已禁用，跳过`, 'warning');
                  continue;
                }

                const modeLabel = runOptions.updateMode === 'append' ? '追加' : '覆盖';
                appendLog(`🔁 渠道 "${channelName}" ${modeLabel} ${mappingList.length} 个模型...`, 'info');

                const analysisResult = { newMappings: mappingList };
                const updateResult = await client.applyModelMappingFix(channel, analysisResult, runOptions);

                if (updateResult.success) {
                  results.updatedChannels++;
                  results.fixedMappings += mappingList.length;
                  appendLog(`✅ 渠道 "${channelName}" 更新成功`, 'success');
                } else {
                  results.errors.push({ channelId: channelIdStr, channelName, error: updateResult.message || '更新失败' });
                  appendLog(`❌ 渠道 "${channelName}" 更新失败: ${updateResult.message || '更新失败'}`, 'error');
                }
              } catch (e) {
                results.errors.push({ channelId: channelIdStr, channelName, error: e.message });
                appendLog(`❌ 渠道 "${channelName}" 更新异常: ${e.message}`, 'error');
              } finally {
                processed++;
                const percent = Math.round((processed / total) * 100);
                runOptions.onProgress?.({
                  stage: 'execute',
                  current: processed,
                  total,
                  percent,
                  channelId: channelIdStr,
                  channelName
                });
              }
            }
          };

          const workerCount = Math.min(maxConcurrency, total);
          await Promise.all(Array.from({ length: workerCount }, worker));

          if (job.cancelled) {
            appendLog('⏹️ 已取消执行', 'warning');
            return {
              success: false,
              cancelled: true,
              message: '已取消',
              results
            };
          }

          appendLog(`🏁 执行完成 - 更新渠道: ${results.updatedChannels}, 修复映射: ${results.fixedMappings}`, 'success');
          return {
            success: true,
            message: '一键更新完成（复用预览结果）',
            results
          };
        };

        const result = dryRun
          ? await client.previewOneClickUpdate(channelIds, runOptions)
          : (fromPreviewJobId
            ? await runExecuteFromPreview(fromPreviewJobId, selectedMappings)
            : await client.oneClickUpdateModels(channelIds, runOptions));

        job.results = result.results || null;
        job.message = result.message || '';

        if (result.cancelled) {
          job.status = 'cancelled';
          job.cancelled = true;
        } else if (result.success) {
          job.status = 'completed';
        } else {
          job.status = 'failed';
          job.error = result.error || result.message || 'unknown error';
        }
      } catch (error) {
        job.status = job.cancelled ? 'cancelled' : 'failed';
        job.error = error.message;
        appendLog(`❌ 任务失败: ${error.message}`, 'error');
      } finally {
        job.finishedAt = Date.now();
      }
    })();

    res.json({ success: true, jobId });
  } catch (error) {
    res.status(500).json({ success: false, message: '启动任务失败', error: error.message });
  }
});

// Poll job status + incremental logs (cursor = index)
app.get('/api/one-click-update-job/:jobId', async (req, res) => {
  try {
    cleanupExpiredJobs();

    const { jobId } = req.params;
    const cursor = Number(req.query.cursor || 0);
    const job = oneClickJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: '任务不存在或已过期' });
    }

    const safeCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
    const logs = job.logs.slice(safeCursor);

    res.json({
      success: true,
      job: {
        id: job.id,
        type: job.type,
        status: job.status,
        cancelled: job.cancelled,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        message: job.message,
        progress: job.progress,
        results: job.results
      },
      logs,
      nextCursor: safeCursor + logs.length
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '获取任务状态失败', error: error.message });
  }
});

// Cancel a running job
app.post('/api/one-click-update-job/:jobId/cancel', async (req, res) => {
  try {
    cleanupExpiredJobs();

    const { jobId } = req.params;
    const job = oneClickJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: '任务不存在或已过期' });
    }

    if (job.status !== 'running') {
      return res.json({ success: true, message: '任务已结束', status: job.status });
    }

    job.cancelled = true;
    job.logs.push({ ts: Date.now(), type: 'warning', msg: '⏹️ 已请求取消' });

    res.json({ success: true, message: '已请求取消' });
  } catch (error) {
    res.status(500).json({ success: false, message: '取消任务失败', error: error.message });
  }
});

// ==================== Scheduled Monitor APIs ====================

// Get monitor status
app.get('/api/monitor/status', (req, res) => {
  try {
    const monitor = getMonitor();
    res.json({ success: true, data: monitor.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, message: '获取监控状态失败', error: error.message });
  }
});

// Get monitor settings
app.get('/api/monitor/settings', (req, res) => {
  try {
    const monitor = getMonitor();
    res.json({ success: true, data: monitor.getSettings() });
  } catch (error) {
    res.status(500).json({ success: false, message: '获取监控设置失败', error: error.message });
  }
});

// Update monitor settings
app.post('/api/monitor/settings', async (req, res) => {
  try {
    const monitor = getMonitor();
    const newSettings = req.body;

    // 如果启用监控，需要先设置配置
    if (newSettings.enabled) {
      try {
        const configData = await fs.readFile(CONFIG_FILE, 'utf8');
        const encrypted = JSON.parse(configData);
        const config = NewAPIClient.decryptConfig(encrypted, SECRET_KEY);
        monitor.setConfig(config);
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: '启用监控前请先配置 API 连接信息'
        });
      }
    }

    const updated = monitor.updateSettings(newSettings);

    // 保存监控设置到文件
    await ensureConfigDir();
    await fs.writeFile(MONITOR_CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');

    res.json({ success: true, data: updated, message: '监控设置已更新' });
  } catch (error) {
    res.status(500).json({ success: false, message: '更新监控设置失败', error: error.message });
  }
});

// Manually trigger a check
app.post('/api/monitor/check', async (req, res) => {
  try {
    const monitor = getMonitor();

    // 确保有配置
    if (!monitor.client) {
      try {
        const configData = await fs.readFile(CONFIG_FILE, 'utf8');
        const encrypted = JSON.parse(configData);
        const config = NewAPIClient.decryptConfig(encrypted, SECRET_KEY);
        monitor.setConfig(config);
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: '请先配置 API 连接信息'
        });
      }
    }

    const result = await monitor.runCheck();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: '手动检测失败', error: error.message });
  }
});

// Test notification
app.post('/api/monitor/test-notification', async (req, res) => {
  try {
    const { type } = req.body; // 'webhook' or 'telegram'
    const monitor = getMonitor();

    // 创建测试数据
    const testResult = {
      scannedChannels: 10,
      brokenMappings: [
        { channelId: 1, channelName: '测试渠道', originalModel: 'test-model', reason: '测试告警' }
      ],
      newMappings: [
        { channelId: 1, channelName: '测试渠道', standardName: 'test-model', actualName: 'test-model-v2', confidence: 95 }
      ]
    };

    if (type === 'webhook') {
      await monitor.sendWebhookAlert(testResult);
    } else if (type === 'telegram') {
      await monitor.sendTelegramAlert(testResult);
    } else {
      return res.status(400).json({ success: false, message: '无效的通知类型' });
    }

    res.json({ success: true, message: '测试通知已发送' });
  } catch (error) {
    res.status(500).json({ success: false, message: '发送测试通知失败', error: error.message });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log('NewAPI 同步工具 v4.0 已启动');
  console.log(`访问地址: http://localhost:${PORT}`);
  console.log(`配置文件: ${CONFIG_FILE}`);
  console.log(`启动时间: ${new Date().toISOString()}`);
  console.log('按 CTRL+C 停止服务');

  if (USING_DEFAULT_SECRET) {
    console.warn('⚠️  [安全警告] 正在使用默认 SECRET_KEY，config.json 的加密形同虚设。');
    console.warn('⚠️  请通过环境变量设置一个强随机 SECRET_KEY 后重启，例如: SECRET_KEY=$(openssl rand -hex 32)');
  }
  if (allowedOrigins.length === 0) {
    console.warn('⚠️  [安全提示] 未设置 ALLOWED_ORIGINS，CORS 允许所有来源。公网部署时请设置 ALLOWED_ORIGINS 并置于带鉴权的反向代理之后。');
  }

  // 尝试加载并启动定时监控
  try {
    const monitorConfigData = await fs.readFile(MONITOR_CONFIG_FILE, 'utf8');
    const monitorSettings = JSON.parse(monitorConfigData);

    if (monitorSettings.enabled) {
      const configData = await fs.readFile(CONFIG_FILE, 'utf8');
      const encrypted = JSON.parse(configData);
      const config = NewAPIClient.decryptConfig(encrypted, SECRET_KEY);

      const monitor = getMonitor();
      monitor.setConfig(config);
      monitor.updateSettings(monitorSettings);

      console.log(`[Monitor] 定时监控已启动，间隔: ${monitorSettings.intervalHours} 小时`);
    }
  } catch (e) {
    // 监控配置不存在或无效，忽略
    if (e.code !== 'ENOENT') {
      console.log('[Monitor] 加载监控配置失败:', e.message);
    }
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n正在关闭服务...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n正在关闭服务...');
  process.exit(0);
});

// Error handler last
app.use((err, req, res, next) => {
  console.error('服务器错误', err);
  res.status(500).json({ success: false, message: '服务器内部错误', error: err.message });
});

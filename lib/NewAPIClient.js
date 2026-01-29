const axios = require('axios');
const crypto = require('crypto-js');
const sharedModelCache = require('./sharedModelCache');

class NewAPIClient {
    constructor(config) {
        this.config = {
            baseUrl: config.baseUrl?.replace(/\/$/, '') || '',
            token: this.cleanToken(config.token || ''),
            userId: config.userId || '1',
            authHeaderType: config.authHeaderType || 'NEW_API',
            timeout: config.timeout || 30000,
            retryAttempts: config.retryAttempts || 3,
            retryDelay: config.retryDelay || 1000,
            enableCache: config.enableCache !== false,
            debug: Boolean(config.debug)
        };

        // 用户规则存储
        this.userRules = {
            nameMatch: [],    // 名称匹配规则
            merge: [],        // 合并规则
            custom: []        // 自定义规则
        };
        
        // 缓存系统
        this.cache = new Map();
        this.cacheExpiry = 5 * 60 * 1000; // 5分钟缓存
        
        // API端点优先级配置
        this.apiEndpoints = {
            models: [
                '/api/models',
                '/api/model/list',
                '/api/model',
                '/api/models/list'
            ],
            channelModels: [
                '/api/channel/{id}',
                '/api/channel/fetch_models/{id}',
                '/api/channel/models/{id}'
            ],
            status: [
                '/api/status',
                '/api/health',
                '/'
            ]
        };
        
        // 调试信息
        if (this.config.token && (this.config.token.includes('\n') || this.config.token.includes('\r'))) {
            console.warn('Token contains line breaks, this may cause issues');
        }
        
        this.validateConfig();
        this.createAxiosInstance();
    }

    validateConfig() {
        const required = ['baseUrl', 'token', 'userId'];
        const missing = required.filter(key => !this.config[key]);
        
        if (missing.length > 0) {
            throw new Error(`缺少必要的配置项: ${missing.join(', ')}`);
        }
    }

    cleanToken(token) {
        return token
            .replace(/^\s+|\s+$/g, '')  // 移除首尾空格
            .replace(/\r\n/g, '')      // 移除换行符
            .replace(/\n/g, '')        // 移除换行符
            .replace(/\r/g, '')        // 移除回车符
            .replace(/\t/g, '')        // 移除制表符
            .trim();
    }

    createAxiosInstance() {
        // 确保token是干净的
        const cleanToken = this.cleanToken(this.config.token);
        
        if (!cleanToken) {
            throw new Error('Token cannot be empty');
        }
        
        const authHeaderType = this.getAuthHeaderType(this.config.authHeaderType);
        
        this.client = axios.create({
            baseURL: this.config.baseUrl,
            timeout: Math.min(this.config.timeout, 30000),
            headers: {
                'Authorization': `Bearer ${cleanToken}`,
                'Content-Type': 'application/json; charset=utf-8',
                [authHeaderType]: this.config.userId
            },
            responseType: 'json',
            responseEncoding: 'utf8'
        });

        // 请求拦截器
        this.client.interceptors.request.use(
            (config) => {
                if (this.config.debug) {
                    console.log(`[${new Date().toISOString()}] ${config.method.toUpperCase()} ${config.url}`);
                }
                config.metadata = { startTime: Date.now() };
                return config;
            },
            (error) => {
                console.error('请求拦截器错误:', error);
                return Promise.reject(error);
            }
        );

        // 响应拦截器
        this.client.interceptors.response.use(
            (response) => {
                const duration = Date.now() - response.config.metadata.startTime;
                if (this.config.debug) {
                    console.log(`[${new Date().toISOString()}] 响应: ${response.status} ${response.config.url} (${duration}ms)`);
                }
                return response;
            },
            (error) => {
                this.handleErrorResponse(error);
                return Promise.reject(error);
            }
        );
    }

    // 缓存管理 - 优化版本
    getCacheKey(url, params = {}) {
        return `${url}_${JSON.stringify(params)}`;
    }

    setCache(url, data, params = {}) {
        if (!this.config.enableCache) return;
        
        const key = this.getCacheKey(url, params);
        const cacheEntry = {
            data,
            timestamp: Date.now(),
            accessCount: 1,
            lastAccess: Date.now()
        };
        
        this.cache.set(key, cacheEntry);
        
        // 缓存大小管理
        if (this.cache.size > 100) {
            this.evictLeastUsedCacheEntries();
        }
    }

    getCache(url, params = {}) {
        if (!this.config.enableCache) return null;
        
        const key = this.getCacheKey(url, params);
        const cached = this.cache.get(key);
        
        if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
            // 更新访问统计
            cached.accessCount++;
            cached.lastAccess = Date.now();
            return cached.data;
        }
        
        // 清理过期缓存
        if (cached) {
            this.cache.delete(key);
        }
        
        return null;
    }

    deleteCache(url, params = {}) {
        if (!this.config.enableCache) return;
        const key = this.getCacheKey(url, params);
        this.cache.delete(key);
    }

    clearCache() {
        this.cache.clear();
        console.log('🗑️ 缓存已清空');
    }

    // 缓存淘汰策略：淘汰最少使用的缓存条目
    evictLeastUsedCacheEntries() {
        const entries = Array.from(this.cache.entries());
        entries.sort((a, b) => {
            // 优先淘汰访问次数少的，其次淘汰最近未使用的
            if (a[1].accessCount !== b[1].accessCount) {
                return a[1].accessCount - b[1].accessCount;
            }
            return a[1].lastAccess - b[1].lastAccess;
        });
        
        // 淘汰20%的缓存
        const evictCount = Math.floor(entries.length * 0.2);
        for (let i = 0; i < evictCount; i++) {
            this.cache.delete(entries[i][0]);
        }
        
        console.log(`🗑️ 淘汰了 ${evictCount} 个缓存条目`);
    }

    // 获取缓存统计信息
    getCacheStats() {
        const totalEntries = this.cache.size;
        const expiredEntries = Array.from(this.cache.values())
            .filter(entry => Date.now() - entry.timestamp > this.cacheExpiry).length;
        
        return {
            totalEntries,
            expiredEntries,
            activeEntries: totalEntries - expiredEntries,
            hitRate: this.calculateCacheHitRate()
        };
    }

    calculateCacheHitRate() {
        // 简化的缓存命中率计算
        return 0; // 实际应用中需要维护命中/未命中计数器
    }

    // 并发控制器
    async concurrentProcessor(tasks, maxConcurrency = 3) {
        const results = [];
        const executing = new Set();
        
        for (const task of tasks) {
            if (executing.size >= maxConcurrency) {
                await Promise.race(executing);
            }
            
            const promise = task().finally(() => {
                executing.delete(promise);
            });
            
            executing.add(promise);
            results.push(promise);
        }
        
        return Promise.all(results);
    }

    // 批量获取渠道模型 - 优化版本
    async batchGetChannelModels(channelIds, maxConcurrency = 3) {
        console.log(`🔄 批量获取 ${channelIds.length} 个渠道的模型 (并发数: ${maxConcurrency})`);
        
        const tasks = channelIds.map(channelId => async () => {
            try {
                const result = await this.getChannelModelsWithCache(channelId);
                return { channelId, result };
            } catch (error) {
                console.warn(`获取渠道 ${channelId} 模型失败:`, error.message);
                return { channelId, error: error.message };
            }
        });
        
        const results = await this.concurrentProcessor(tasks, maxConcurrency);
        
        const successful = results.filter(r => !r.error).length;
        const failed = results.filter(r => r.error).length;
        
        console.log(`✅ 批量获取完成: 成功 ${successful}, 失败 ${failed}`);
        
        return results;
    }

    // 智能重试机制
    async retryWithBackoff(fn, maxAttempts = this.config.retryAttempts, baseDelay = this.config.retryDelay) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                
                if (attempt === maxAttempts) {
                    throw error;
                }
                
                const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
                console.warn(`尝试 ${attempt}/${maxAttempts} 失败，${delay}ms 后重试: ${error.message}`);
                
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        throw lastError;
    }

    // 智能API端点测试 - 优化版本
    async testEndpoints(endpoints, testData = null) {
        const results = [];
        const controller = new AbortController();
        
        // 并行测试所有端点，设置总超时
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                controller.abort();
                reject(new Error('端点测试超时'));
            }, Math.min(endpoints.length * 3000, 15000)); // 动态超时
        });

        try {
            const testPromises = endpoints.map(async (endpoint) => {
                try {
                    const response = await this.client.get(endpoint, { 
                        timeout: 4000,
                        validateStatus: (status) => status < 500,
                        signal: controller.signal
                    });
                    
                    const hasModels = this.checkIfHasModels(response.data);
                    const result = {
                        endpoint,
                        status: 'success',
                        response: response.data,
                        hasModels,
                        responseTime: response.config.metadata ? 
                            Date.now() - response.config.metadata.startTime : 0
                    };
                    
                    // 如果找到了包含模型数据的端点，记录但不立即返回
                    // 让所有测试完成以获得完整的端点信息
                    if (hasModels) {
                        console.log(`✅ 发现模型端点: ${endpoint} (${result.responseTime}ms)`);
                    }
                    
                    return result;
                    
                } catch (error) {
                    return {
                        endpoint,
                        status: 'error',
                        error: error.message,
                        aborted: error.name === 'AbortError'
                    };
                }
            });

            results.push(...await Promise.race([
                Promise.all(testPromises),
                timeoutPromise
            ]));
            
        } catch (error) {
            if (error.message === '端点测试超时') {
                console.warn('⚠️ 端点测试超时，使用已获得的结果');
            }
        }
        
        // 按响应时间排序，优先返回最快的有效端点
        const successfulEndpoints = results
            .filter(r => r.status === 'success' && r.hasModels)
            .sort((a, b) => a.responseTime - b.responseTime);
        
        if (successfulEndpoints.length > 0) {
            console.log(`🎯 最佳端点: ${successfulEndpoints[0].endpoint} (${successfulEndpoints[0].responseTime}ms)`);
        }
        
        return results;
    }

    handleErrorResponse(error) {
        let errorMessage = '未知错误';
        
        if (error.response) {
            const { status, data, statusText } = error.response;
            
            if (data && typeof data === 'object') {
                errorMessage = data.message || data.error || JSON.stringify(data);
            } else {
                errorMessage = `HTTP ${status}: ${statusText}`;
            }
            
            console.error(`[${new Date().toISOString()}] HTTP错误 ${status}:`, errorMessage);
        } else if (error.code === 'ECONNABORTED') {
            errorMessage = '请求超时';
            console.error(`[${new Date().toISOString()}] 请求超时:`, error.message);
        } else if (error.code === 'ENOTFOUND') {
            errorMessage = '无法解析服务器地址';
            console.error(`[${new Date().toISOString()}] DNS解析失败:`, error.message);
        } else if (error.code === 'ECONNREFUSED') {
            errorMessage = '连接被拒绝';
            console.error(`[${new Date().toISOString()}] 连接被拒绝:`, error.message);
        } else {
            errorMessage = error.message;
            console.error(`[${new Date().toISOString()}] 网络错误:`, error.message);
        }
        
        error.userMessage = errorMessage;
    }

    async testConnection() {
        try {
            console.log('🔄 开始智能连接测试...');
            
            // 智能测试状态端点
            const statusResults = await this.testEndpoints(this.apiEndpoints.status);
            const statusOk = statusResults.some(r => r.status === 'success');
            const apiStatus = statusResults.find(r => r.status === 'success')?.response;
            
            // 智能测试渠道端点
            const channelTestUrl = '/api/channel/?page=1&page_size=1';
            let channelsOk = false;
            let channelError = null;
            
            try {
                const channelResponse = await this.retryWithBackoff(() =>
                    this.client.get(channelTestUrl, { timeout: 8000 })
                );
                channelsOk = channelResponse.status === 200;
            } catch (error) {
                channelError = error.message;
            }
            
            const errors = [];
            if (!statusOk) {
                errors.push('状态检查失败');
            }
            if (!channelsOk) {
                errors.push(`渠道权限检查失败: ${channelError || '未知错误'}`);
            }
            
            if (statusOk || channelsOk) {
                return {
                    success: true,
                    message: statusOk && channelsOk ? '✅ 连接完全成功' : '⚠️ 连接基本成功（部分功能可用）',
                    status: statusOk ? 200 : channelsOk ? 200 : null,
                    apiStatus,
                    channelsAccessible: channelsOk,
                    endpointsTested: {
                        status: statusResults.filter(r => r.status === 'success').length,
                        channels: channelsOk ? 1 : 0
                    },
                    warnings: errors.length > 0 ? errors : undefined,
                    recommendations: this.generateConnectionRecommendations(statusOk, channelsOk, statusResults)
                };
            } else {
                throw new Error(`❌ 连接失败: ${errors.join('; ')}`);
            }
            
        } catch (error) {
            console.error('❌ 连接测试失败:', error);
            return {
                success: false,
                message: error.userMessage || error.message || '连接失败',
                error: error.message,
                code: error.code,
                status: error.response?.status,
                suggestions: this.generateConnectionSuggestions(error)
            };
        }
    }

    generateConnectionRecommendations(statusOk, channelsOk, statusResults) {
        const recommendations = [];
        
        if (!statusOk) {
            const workingEndpoints = statusResults.filter(r => r.status === 'success');
            if (workingEndpoints.length > 0) {
                recommendations.push(`✅ 发现可用端点: ${workingEndpoints.map(r => r.endpoint).join(', ')}`);
            } else {
                recommendations.push('⚠️ 建议检查API服务器状态和网络连接');
            }
        }
        
        if (!channelsOk) {
            recommendations.push('⚠️ 建议检查访问令牌权限和用户ID设置');
        }
        
        return recommendations;
    }

    generateConnectionSuggestions(error) {
        const suggestions = [];
        
        if (error.code === 'ECONNREFUSED') {
            suggestions.push('检查服务器地址是否正确');
            suggestions.push('确认API服务正在运行');
        } else if (error.code === 'ENOTFOUND') {
            suggestions.push('检查域名解析是否正确');
            suggestions.push('确认网络连接正常');
        } else if (error.code === 'ECONNABORTED') {
            suggestions.push('请求超时，请检查网络延迟');
            suggestions.push('尝试增加超时时间');
        } else if (error.response?.status === 401) {
            suggestions.push('检查访问令牌是否有效');
            suggestions.push('确认认证类型设置正确');
        } else if (error.response?.status === 403) {
            suggestions.push('检查用户权限设置');
            suggestions.push('确认用户ID是否正确');
        } else if (error.response?.status === 404) {
            suggestions.push('API端点不存在，可能版本不兼容');
            suggestions.push('检查API版本和路径');
        }
        
        return suggestions;
    }

    // 快速连接测试 - 增强稳定性版本
    async quickConnectionTest() {
        const endpoints = [
            { url: '/api/status', timeout: 5000, name: 'API状态' },
            { url: '/api/health', timeout: 5000, name: '健康检查' },
            { url: '/', timeout: 3000, name: '根路径' }
        ];

        for (const endpoint of endpoints) {
            try {
                console.log(`尝试连接: ${endpoint.name} (${endpoint.url})`);

                const response = await this.retryWithBackoff(
                    () => this.client.get(endpoint.url, {
                        timeout: endpoint.timeout,
                        validateStatus: (status) => status < 500 // 接受4xx错误，只检查服务器是否可达
                    }),
                    2, // 重试2次
                    800 // 基础延迟800ms
                );

                console.log(`✅ ${endpoint.name} 连接成功 (${response.status})`);
                return {
                    success: true,
                    message: `服务器可达 (${endpoint.name})`,
                    status: response.status,
                    endpoint: endpoint.url,
                    quickTest: true,
                    responseTime: response.config.metadata ?
                        Date.now() - response.config.metadata.startTime : 0
                };
            } catch (error) {
                console.log(`❌ ${endpoint.name} 连接失败: ${error.message}`);
                // 继续尝试下一个端点
            }
        }

        return {
            success: false,
            message: '所有连接尝试都失败',
            error: '服务器无法连接',
            suggestions: [
                '检查网络连接是否正常',
                '确认服务器地址是否正确',
                '检查防火墙设置',
                '等待网络稳定后重试'
            ]
        };
    }

    async getChannels(page = 1, pageSize = 100) {
        try {
            console.log(`📡 获取渠道列表: 第${page}页, 每页${pageSize}个`);
            const response = await this.client.get('/api/channel/', {
                params: {
                    page,
                    page_size: pageSize
                }
            });
            
            console.log(`📊 渠道API响应状态: ${response.status}`);
            console.log(`📄 渠道API原始响应:`, JSON.stringify(response.data, null, 2).substring(0, 500));
            
            // 基于 gpt-api-sync 的响应格式解析
            if (response.data && response.data.success) {
                const items = response.data.data.items || response.data.data || [];
                const total = response.data.data.total || items.length;
                const currentPage = response.data.data.page || page;
                
                console.log(`✅ 成功获取 ${items.length} 个渠道 (总计: ${total})`);
                return {
                    success: true,
                    data: items,
                    total: total,
                    page: currentPage
                };
            }
            
            // 尝试直接解析响应数据
            const data = response.data;
            if (Array.isArray(data)) {
                console.log(`✅ 直接解析到 ${data.length} 个渠道`);
                return {
                    success: true,
                    data: data,
                    total: data.length,
                    page: 1
                };
            }
            
            // 尝试其他可能的响应格式
            if (data && data.items && Array.isArray(data.items)) {
                console.log(`✅ 从items字段解析到 ${data.items.length} 个渠道`);
                return {
                    success: true,
                    data: data.items,
                    total: data.total || data.items.length,
                    page: data.page || 1
                };
            }
            
            // 尝试处理 data.data 格式
            if (data && data.data && Array.isArray(data.data)) {
                console.log(`✅ 从data.data字段解析到 ${data.data.length} 个渠道`);
                return {
                    success: true,
                    data: data.data,
                    total: data.total || data.data.length,
                    page: data.page || page
                };
            }
            
            // 尝试处理 list 字段格式
            if (data && data.list && Array.isArray(data.list)) {
                console.log(`✅ 从list字段解析到 ${data.list.length} 个渠道`);
                return {
                    success: true,
                    data: data.list,
                    total: data.total || data.list.length,
                    page: data.page || page
                };
            }
            
            // 尝试处理 channels 字段格式
            if (data && data.channels && Array.isArray(data.channels)) {
                console.log(`✅ 从channels字段解析到 ${data.channels.length} 个渠道`);
                return {
                    success: true,
                    data: data.channels,
                    total: data.total || data.channels.length,
                    page: data.page || page
                };
            }
            
            // 尝试处理结果数组格式
            if (data && data.result && Array.isArray(data.result)) {
                console.log(`✅ 从result字段解析到 ${data.result.length} 个渠道`);
                return {
                    success: true,
                    data: data.result,
                    total: data.total || data.result.length,
                    page: data.page || page
                };
            }
            
            // 如果是对象但不是标准格式，尝试提取数组字段
            if (data && typeof data === 'object') {
                const arrayFields = Object.keys(data).filter(key => Array.isArray(data[key]));
                if (arrayFields.length > 0) {
                    const firstField = arrayFields[0];
                    const arrayData = data[firstField];
                    console.log(`✅ 从${firstField}字段解析到 ${arrayData.length} 个渠道`);
                    return {
                        success: true,
                        data: arrayData,
                        total: data.total || arrayData.length,
                        page: data.page || page
                    };
                }
            }
            
            console.warn(`⚠️ 渠道API响应格式异常:`, JSON.stringify(data, null, 2));
            return {
                success: false,
                message: '渠道API响应格式异常',
                error: '无法解析渠道数据'
            };
        } catch (error) {
            console.error('❌ 获取渠道失败:', error.message);
            return {
                success: false,
                message: error.userMessage,
                error: error.message
            };
        }
    }

    async updateChannel(channelData) {
        try {
            // 修复：根据Java版本，直接发送channel数据，不包装在mode/channel结构中
            const hasModelsField = Object.prototype.hasOwnProperty.call(channelData, 'models');
            const updatePayload = {
                // 必需字段
                id: channelData.id,
                models: hasModelsField ? channelData.models : "",
                status: channelData.status || 1,
                type: channelData.type || 1,
                test_model: channelData.test_model || "gpt-3.5-turbo",
                base_url: channelData.base_url || "",
                key: channelData.key || "",
                name: channelData.name || "",
                weight: channelData.weight || 0,
                // 模型重定向映射字段 - 修复字段位置
                ...(channelData.model_mapping && { model_mapping: channelData.model_mapping }),
                // 其他可选字段
                ...(channelData.priority !== undefined && { priority: channelData.priority }),
                ...(channelData.auto_ban !== undefined && { auto_ban: channelData.auto_ban }),
                ...(channelData.tag !== undefined && { tag: channelData.tag }),
                ...(channelData.group !== undefined && { group: channelData.group })
            };

            console.log(`🔄 更新渠道 ${channelData.id}, 修复后的数据结构:`, JSON.stringify(updatePayload, null, 2));

            const response = await this.client.put('/api/channel/', updatePayload);

            const responseData = response.data || {};
            if (responseData && responseData.success === false) {
                return {
                    success: false,
                    message: responseData.message || '渠道更新失败',
                    data: responseData
                };
            }

            return {
                success: true,
                message: responseData.message || '渠道更新成功',
                data: responseData
            };
        } catch (error) {
            console.error(`❌ 更新渠道失败:`, error.message);
            return {
                success: false,
                message: error.userMessage,
                error: error.message
            };
        }
    }

    async getChannelModels(channelId, forceRefresh = false) {
        return await this.getChannelModelsWithCache(channelId, forceRefresh);
    }

    /**
     * 获取渠道模型列表（支持缓存和强制刷新）
     * @param {string|number} channelId - 渠道ID
     * @param {boolean} forceRefresh - 是否强制刷新（跳过缓存）
     * @returns {Object} 模型列表结果
     */
    async getChannelModelsWithCache(channelId, forceRefresh = false) {
        try {
            console.log(`🔍 正在智能获取渠道 ${channelId} 的模型列表...${forceRefresh ? ' (强制刷新)' : ''}`);

            const cacheKey = `channel_models_${channelId}`;

            // 如果强制刷新，先清除该渠道的缓存
            if (forceRefresh) {
                this.deleteCache(cacheKey);
                console.log(`🔄 已清除渠道 ${channelId} 的缓存，正在从API获取最新数据...`);
            } else {
                // 检查缓存
                const cached = this.getCache(cacheKey);
                if (cached) {
                    console.log(`✅ 从缓存获取到 ${cached.length} 个模型`);
                    return {
                        success: true,
                        data: cached,
                        message: `从缓存获取 ${cached.length} 个模型`,
                        source: 'cache'
                    };
                }
            }
            
            // 智能获取渠道模型
            const result = await this.smartGetChannelModels(channelId);
            const models = result.models || [];
            const source = result.source || 'unknown';

            if (models.length > 0) {
                // 缓存结果
                this.setCache(cacheKey, models);

                return {
                    success: true,
                    data: models,
                    message: `成功获取 ${models.length} 个模型`,
                    source: source
                };
            }
            
            return {
                success: false,
                message: '无法获取模型列表',
                error: '所有API接口都返回空数据',
                suggestions: [
                    '检查API令牌是否有效',
                    '检查渠道ID是否正确',
                    '检查渠道是否有权限访问模型',
                    '确认NewAPI服务正常运行'
                ]
            };
            
        } catch (error) {
            console.error(`❌ 获取渠道 ${channelId} 模型失败:`, error);
            return {
                success: false,
                message: error.userMessage || '获取模型失败',
                error: error.message,
                code: error.code
            };
        }
    }

  async smartGetChannelModels(channelId) {
        console.log(`🔍 获取渠道 ${channelId} 模型...`);

        // 方法1: 优先使用 fetch_models 端点获取渠道商的全部模型
        // 注意: /api/channel/${channelId} 只返回NewAPI内已选择的模型，应该放在最后
        const channelEndpoints = [
            `/api/channel/fetch_models/${channelId}`,
            `/api/channel/models/${channelId}`,
            `/api/channel/${channelId}`
        ];

        for (const endpoint of channelEndpoints) {
            try {
                console.log(`📡 尝试端点: ${endpoint}`);
                const response = await this.retryWithBackoff(() =>
                    this.client.get(endpoint, { timeout: 10000 })
                );

                if (response.status === 200) {
                    const models = this.extractModelsFromResponse(response.data);
                    if (models.length > 0) {
                        console.log(`✅ 通过端点获取到 ${models.length} 个模型: ${endpoint}`);
                        // 返回模型和来源信息
                        const isFallback = endpoint === `/api/channel/${channelId}`;
                        return { models, source: isFallback ? 'fallback' : 'fetch_models' };
                    }
                }
            } catch (error) {
                console.log(`端点失败 ${endpoint}:`, error.message);
            }
        }

        // 方法2: 尝试从全局模型获取
        try {
            console.log(`📡 尝试全局模型端点...`);
            const globalEndpoints = ['/api/models', '/api/model/list', '/api/models/list'];

            for (const endpoint of globalEndpoints) {
                try {
                    const response = await this.retryWithBackoff(() =>
                        this.client.get(endpoint, { timeout: 10000 })
                    );

                    if (response.status === 200) {
                        const models = this.extractModelsFromResponse(response.data);
                        if (models.length > 0) {
                            console.log(`✅ 通过全局端点获取到 ${models.length} 个模型: ${endpoint}`);
                            return { models, source: 'global' };
                        }
                    }
                } catch (error) {
                    console.log(`全局端点失败 ${endpoint}:`, error.message);
                }
            }
        } catch (error) {
            console.log('全局模型获取失败:', error.message);
        }

        console.warn(`❌ 所有方法都失败了，渠道 ${channelId}`);
        return { models: [], source: 'none' };
    }

  extractModelsFromResponse(data) {
        if (!data) return [];
        
        let models = [];
        
        // 检查不同的数据结构
        if (data.success && data.data) {
            // 标准API响应格式
            if (Array.isArray(data.data)) {
                models = data.data;
            } else if (data.data.models) {
                models = this.parseModels(data.data.models);
            } else if (data.data.items) {
                models = data.data.items;
            } else if (data.data.list) {
                models = data.data.list;
            }
        } else if (data.models) {
            // 直接包含models字段
            models = this.parseModels(data.models);
        } else if (Array.isArray(data)) {
            // 直接是数组
            models = data;
        } else if (data.items) {
            // 包含items字段
            models = Array.isArray(data.items) ? data.items : [];
        } else if (data.list) {
            // 包含list字段
            models = Array.isArray(data.list) ? data.list : [];
        } else if (data.data && Array.isArray(data.data)) {
            // 嵌套data字段
            models = data.data;
        }
        
        // 尝试从对象中提取数组字段
        if (models.length === 0 && typeof data === 'object') {
            const arrayFields = Object.keys(data).filter(key => 
                Array.isArray(data[key]) && data[key].length > 0
            );
            if (arrayFields.length > 0) {
                const firstField = arrayFields[0];
                models = data[firstField];
                console.log(`🔍 从${firstField}字段提取到${models.length}个模型`);
            }
        }
        
        // 清理和去重模型名称
        return models
            .map(model => typeof model === 'string' ? model.trim() : model)
            .filter(model => model && typeof model === 'string' && model.length > 0)
            .filter((model, index, self) => self.indexOf(model) === index);
    }

    
  parseModels(modelsData) {
        if (Array.isArray(modelsData)) {
            return modelsData;
        }
        
        if (typeof modelsData === 'string') {
            return modelsData
                .split(/[,|;|\n]/)
                .map(model => model.trim())
                .filter(model => model.length > 0);
        }
        
        return [];
    }

    async getAllModels() {
        try {
            console.log('🔍 正在智能获取所有可用模型...');
            
            // 检查缓存
            const cacheKey = 'global_models';
            const cached = this.getCache(cacheKey);
            if (cached) {
                console.log(`✅ 从缓存获取到 ${cached.length} 个全局模型`);
                return {
                    success: true,
                    data: cached,
                    source: 'cache'
                };
            }
            
            // 智能测试模型端点
            const results = await this.testEndpoints(this.apiEndpoints.models);
            const successfulEndpoint = results.find(r => r.status === 'success' && r.hasModels);
            
            if (successfulEndpoint) {
                const models = this.extractModelsFromResponse(successfulEndpoint.response);
                console.log(`✅ 通过 ${successfulEndpoint.endpoint} 获取到 ${models.length} 个模型`);
                
                // 缓存结果
                this.setCache(cacheKey, models);
                
                return {
                    success: true,
                    data: models,
                    source: successfulEndpoint.endpoint
                };
            }
            
            // 如果没有找到模型，尝试从渠道获取
            console.log('⚠️ 未找到全局模型端点，尝试从渠道获取...');
            const channelsResult = await this.getChannels(1, 10); // 只获取前10个渠道
            
            if (channelsResult.success && channelsResult.data.length > 0) {
                const allModels = new Set();
                
                for (const channel of channelsResult.data.slice(0, 5)) { // 只处理前5个渠道
                    try {
                        const channelModelsResult = await this.getChannelModels(channel.id);
                        if (channelModelsResult.success) {
                            channelModelsResult.data.forEach(model => allModels.add(model));
                        }
                    } catch (error) {
                        console.warn(`获取渠道 ${channel.name} 模型失败:`, error.message);
                    }
                }
                
                const models = Array.from(allModels);
                if (models.length > 0) {
                    console.log(`✅ 从渠道聚合获取到 ${models.length} 个模型`);
                    
                    // 缓存结果
                    this.setCache(cacheKey, models);
                    
                    return {
                        success: true,
                        data: models,
                        source: 'channel-aggregate'
                    };
                }
            }
            
            return {
                success: false,
                message: '无法获取模型列表',
                suggestions: [
                    '检查API端点配置',
                    '确认访问权限',
                    '尝试调试API接口'
                ]
            };
            
        } catch (error) {
            console.error('❌ 获取所有模型失败:', error);
            return {
                success: false,
                message: error.message,
                error: error.message
            };
        }
    }

    async syncModels(modelMapping, modelUpdateMode = 'append', channelIds = null) {
        const startTime = Date.now();
        const logs = [];
        let successCount = 0;
        let failCount = 0;
        let unchangedCount = 0;
        let skippedCount = 0;

        try {
            logs.push('🔄 开始智能模型同步...');
            
            // 如果没有提供模型映射，自动生成智能映射
            if (!modelMapping || Object.keys(modelMapping).length === 0) {
                logs.push('🔍 未提供模型映射，开始自动生成智能映射...');
                
                // 获取标准模型列表
                const standardModels = this.getStandardModels();
                logs.push(`📋 标准模型列表: ${standardModels.length} 个模型`);
                
                // 获取所有可用模型（从全局或渠道聚合）
                const allModelsResult = await this.getAllModels();
                if (allModelsResult.success && allModelsResult.data.length > 0) {
                    const actualModels = allModelsResult.data;
                    logs.push(`📋 发现可用模型: ${actualModels.length} 个`);
                    
                    // 生成智能模型映射
                    modelMapping = this.generateSmartModelMapping(standardModels, actualModels);
                    logs.push(`🎯 自动生成映射规则: ${Object.keys(modelMapping).length} 个`);
                    
                    // 显示映射详情
                    Object.entries(modelMapping).forEach(([standard, actual]) => {
                        logs.push(`  📝 ${standard} → ${actual}`);
                    });
                } else {
                    logs.push('⚠️ 无法获取可用模型列表，使用空映射');
                    modelMapping = {};
                }
            } else {
                logs.push(`📊 使用提供的映射规则: ${Object.keys(modelMapping).length} 个`);
            }
            
            // 获取要同步的渠道
            let channels = [];
            let totalChannels = 0;

            if (channelIds && Array.isArray(channelIds) && channelIds.length > 0) {
                // 如果指定了渠道ID，只获取指定的渠道
                logs.push(`🎯 指定同步 ${channelIds.length} 个渠道: ${channelIds.join(', ')}`);

                // 获取所有渠道以找到指定的渠道
                const allChannelsResult = await this.getChannels(1, 1000); // 获取更多渠道
                if (!allChannelsResult.success) {
                    throw new Error(`获取渠道失败: ${allChannelsResult.message}`);
                }

                // 调试：打印所有渠道ID和类型
                logs.push(`🔍 调试信息：获取到 ${allChannelsResult.data.length} 个渠道`);
                logs.push(`🔍 指定的渠道ID类型: ${channelIds.map(id => typeof id)}, 值: [${channelIds.join(', ')}]`);
                logs.push(`🔍 所有渠道ID: ${allChannelsResult.data.map(ch => `${ch.id}(${typeof ch.id})`).join(', ')}`);

                // 确保渠道ID数据类型一致 - 将所有渠道ID转换为字符串进行比较
                const normalizedChannelIds = channelIds.map(id => String(id));
                logs.push(`🔍 标准化后的渠道ID: [${normalizedChannelIds.join(', ')}]`);

                // 筛选出指定的渠道
                channels = allChannelsResult.data.filter(channel => {
                    const channelMatch = normalizedChannelIds.includes(String(channel.id));
                    logs.push(`🔍 渠道 ${channel.id}(${typeof channel.id}) "${channel.name}" 匹配结果: ${channelMatch}`);
                    return channelMatch;
                });

                if (channels.length === 0) {
                    logs.push(`❌ 筛选失败！`);
                    logs.push(`❌ 指定的渠道ID: [${channelIds.join(', ')}]`);
                    logs.push(`❌ 所有渠道ID: [${allChannelsResult.data.map(ch => ch.id).join(', ')}]`);
                    throw new Error(`未找到指定的渠道，请检查渠道ID是否正确: ${channelIds.join(', ')}`);
                }

                logs.push(`📋 从 ${allChannelsResult.data.length} 个渠道中筛选出 ${channels.length} 个指定渠道`);
                totalChannels = channelIds.length;
            } else {
                // 如果没有指定渠道，获取所有渠道（保持向后兼容）
                logs.push(`⚠️ 未指定渠道，将同步所有渠道`);

                const channelsResult = await this.getChannels(1, 100);
                if (!channelsResult.success) {
                    throw new Error(`获取渠道失败: ${channelsResult.message}`);
                }

                channels = channelsResult.data;
                totalChannels = channelsResult.total || channels.length;

                // 如果还有更多渠道，继续获取
                if (totalChannels > 100) {
                    const totalPages = Math.ceil(totalChannels / 100);
                    logs.push(`📋 发现 ${totalChannels} 个渠道，分 ${totalPages} 页获取`);

                    for (let page = 2; page <= totalPages; page++) {
                        const moreChannelsResult = await this.getChannels(page, 100);
                        if (moreChannelsResult.success) {
                            channels = channels.concat(moreChannelsResult.data);
                        } else {
                            logs.push(`⚠️ 获取第 ${page} 页渠道失败: ${moreChannelsResult.message}`);
                        }
                    }
                }

                logs.push(`📋 成功获取 ${channels.length} 个渠道（全部）`);
            }
            
            // 批量处理渠道（控制并发数）
            const batchSize = 5; // 每批处理5个渠道
            const totalBatches = Math.ceil(channels.length / batchSize);
            
            logs.push(`🔄 开始批量处理，共 ${totalBatches} 批，每批 ${batchSize} 个渠道`);
            
            for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                const startIdx = batchIndex * batchSize;
                const endIdx = Math.min(startIdx + batchSize, channels.length);
                const batchChannels = channels.slice(startIdx, endIdx);
                
                logs.push(`🔄 处理第 ${batchIndex + 1}/${totalBatches} 批 (渠道 ${startIdx + 1}-${endIdx})`);
                
                // 并发处理当前批次
                const batchPromises = batchChannels.map(async (channel) => {
                    try {
                        return await this.processChannelForSync(channel, modelMapping, modelUpdateMode);
                    } catch (error) {
                        return {
                            channelId: channel.id,
                            channelName: channel.name,
                            success: false,
                            error: error.message,
                            action: 'error'
                        };
                    }
                });
                
                const batchResults = await Promise.all(batchPromises);
                
                // 统计批次结果
                batchResults.forEach(result => {
                    switch (result.action) {
                        case 'updated':
                            successCount++;
                            logs.push(`✅ 渠道 "${result.channelName}" 更新成功 (${result.changedCount} 个模型变更)`);
                            break;
                        case 'unchanged':
                            unchangedCount++;
                            logs.push(`✅ 渠道 "${result.channelName}" 无需更新`);
                            break;
                        case 'skipped':
                            skippedCount++;
                            logs.push(`⏭️ 渠道 "${result.channelName}" 跳过 (${result.reason})`);
                            break;
                        case 'error':
                            failCount++;
                            logs.push(`❌ 渠道 "${result.channelName}" 处理失败: ${result.error}`);
                            break;
                    }
                });
                
                // 批次间延迟，避免API限制
                if (batchIndex < totalBatches - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
            const duration = Date.now() - startTime;
            logs.push(`🏁 同步完成 - 成功: ${successCount}, 失败: ${failCount}, 未变更: ${unchangedCount}, 跳过: ${skippedCount}, 耗时: ${duration}ms`);
            
            // 性能统计
            const avgTimePerChannel = channels.length > 0 ? Math.round(duration / channels.length) : 0;
            logs.push(`📈 平均每渠道处理时间: ${avgTimePerChannel}ms`);
            
            return {
                success: true,
                message: '同步完成',
                logs,
                modelMapping,  // 返回使用的模型映射
                stats: {
                    success: successCount,
                    failed: failCount,
                    unchanged: unchangedCount,
                    skipped: skippedCount,
                    totalChannels: channels.length,
                    duration,
                    avgTimePerChannel
                }
            };
        } catch (error) {
            const duration = Date.now() - startTime;
            logs.push(`❌ 同步失败: ${error.message}`);
            
            return {
                success: false,
                message: error.userMessage || error.message,
                error: error.message,
                logs,
                stats: {
                    duration,
                    suggestions: this.generateSyncSuggestions(error)
                }
            };
        }
    }

    // 处理单个渠道的同步
    async processChannelForSync(channel, modelMapping, modelUpdateMode = 'append') {
        // 深拷贝 modelMapping 避免多渠道并发处理时共享状态问题
        const channelModelMapping = modelMapping ? JSON.parse(JSON.stringify(modelMapping)) : {};

        const originalModels = this.parseModelList(channel.models);
        const originalModelSet = new Set(originalModels);

        // 检查渠道是否有模型
        if (originalModels.length === 0) {
            return {
                channelId: channel.id,
                channelName: channel.name,
                success: true,
                action: 'skipped',
                reason: '无模型'
            };
        }

        // 检查渠道状态
        if (channel.status !== 1) {
            return {
                channelId: channel.id,
                channelName: channel.name,
                success: true,
                action: 'skipped',
                reason: `渠道状态异常 (${channel.status})`
            };
        }

        // 过滤出与当前渠道模型相关的映射
        // 前端发送格式: { 标准模型名: 实际模型名 }
        // NewAPI model_mapping 格式: { 标准模型名: 实际模型名 }
        const relevantMapping = {};
        
        // 调试：打印传入的 modelMapping
        console.log(`🔍 [DEBUG] 渠道 ${channel.id} (${channel.name}): modelMapping 参数 =`, JSON.stringify(modelMapping));
        console.log(`🔍 [DEBUG] 渠道 ${channel.id} (${channel.name}): channelModelMapping =`, JSON.stringify(channelModelMapping));
        
        if (channelModelMapping && Object.keys(channelModelMapping).length > 0) {
            console.log(`🔍 渠道 ${channel.id} (${channel.name}): 检查映射匹配, 有 ${Object.keys(channelModelMapping).length} 个规��`);
            console.log(`🔍 渠道原始模型列表 (前10个): ${originalModels.slice(0, 10).join(', ')}${originalModels.length > 10 ? '...' : ''}`);
            console.log(`🔍 前端发送的映射: ${JSON.stringify(channelModelMapping)}`);

            for (const [standardName, actualName] of Object.entries(channelModelMapping)) {
                const standardModel = String(standardName || '').trim();
                const actualModel = String(actualName || '').trim();
                if (!standardModel || !actualModel) {
                    continue;
                }

                let foundModel = originalModelSet.has(actualModel);
                
                if (!foundModel) {
                    foundModel = originalModels.some(m => {
                        const cleanActual = actualModel.replace(/^[^/]+\//, '');
                        const cleanModel = m.replace(/^[^/]+\//, '');
                        return m === actualModel || cleanModel === cleanActual || m.includes(actualModel);
                    });
                }
                
                if (!foundModel && modelUpdateMode === 'replace' && channel.model_mapping) {
                    try {
                        const existingMapping = JSON.parse(channel.model_mapping);
                        const reverseMatch = Object.entries(existingMapping).find(
                            ([mappedName, originalName]) => mappedName === actualModel || originalName === actualModel
                        );
                        if (reverseMatch) {
                            foundModel = true;
                            console.log(`🔄 覆盖模式：允许修改已映射的名称 ${actualModel}`);
                        }
                    } catch (e) {
                        // ignore
                    }
                }
                
                if (foundModel) {
                    relevantMapping[standardModel] = actualModel;
                    console.log(`✅ 添加映射: ${standardModel} → ${actualModel}`);
                } else {
                    console.log(`⏭️ 跳过映射: ${standardModel} → ${actualModel} (渠道不包含 ${actualModel})`);
                }
            }

            if (Object.keys(relevantMapping).length > 0) {
                console.log(`🎯 渠道 ${channel.id} (${channel.name}): 添加 ${Object.keys(relevantMapping).length} 个映射`);
            }
        }

        // 处理模型重定向映射
        let modelMappingString = null;
        let mappingChanges = [];

        if (Object.keys(relevantMapping).length > 0) {
            // 将模型映射转换为JSON字符串，这是NewAPI需要的格式
            modelMappingString = JSON.stringify(relevantMapping);

            // 记录映射详情用于日志
            mappingChanges = Object.entries(relevantMapping).map(([source, target]) =>
                `${source} → ${target}`
            );
        }

        // 生成新的模型列表以检查变化
        let previewModelsList = [...originalModels];
        if (Object.keys(relevantMapping).length > 0) {
            // 使用映射后的模型名称（键）
            const mappedModels = Object.keys(relevantMapping);
            previewModelsList.push(...mappedModels);
            previewModelsList = [...new Set(previewModelsList)];
        }
        const newModelsString = previewModelsList.join(',');

        // 检查是否有变化
        const modelsChanged = newModelsString !== (channel.models || '');
        const mappingChanged = modelMappingString !== (channel.model_mapping || null);

        console.log(`🔍 渠道 ${channel.id} 变化检测:`);
        console.log(`  - 现有模型列表: ${channel.models ? channel.models.substring(0, 100) + '...' : '(空)'}`);
        console.log(`  - 新模型列表: ${newModelsString.substring(0, 100)}...`);
        console.log(`  - 模型列表变化: ${modelsChanged}`);
        console.log(`  - 现有映射: ${channel.model_mapping ? channel.model_mapping.substring(0, 100) + '...' : '(空)'}`);
        console.log(`  - 新映射: ${modelMappingString ? modelMappingString.substring(0, 100) + '...' : '(空)'}`);
        console.log(`  - 映射变化: ${mappingChanged}`);

        // 覆盖模式：强制更新，无论内容是否相同
        if (modelUpdateMode === 'replace') {
            console.log(`🔄 渠道 ${channel.id}: 覆盖模式，强制更新`);
        } else {
            // 追加模式：检查是否需要更新
            const needsUpdate = modelsChanged || mappingChanged || (modelUpdateMode === 'append' && channel.model_mapping);

            // 如果没有任何变化，跳过更新
            if (!needsUpdate) {
                console.log(`✅ 渠道 ${channel.id} 无需更新（模型和映射都未变化）`);
                return {
                    channelId: channel.id,
                    channelName: channel.name,
                    success: true,
                    action: 'unchanged',
                    changedCount: 0
                };
            }
        }

        try {
            // 根据模式生成新的模型列表
            let finalModelsList = [];

            if (modelUpdateMode === 'replace') {
                // 覆盖模式：完全替换模型列表
                if (Object.keys(relevantMapping).length > 0) {
                    // 使用映射后的模型名称（键）
                    finalModelsList = Object.keys(relevantMapping);
                    console.log(`🔄 渠道 ${channel.id}: 使用覆盖模式，仅保留 ${finalModelsList.length} 个映射后的模型`);
                } else {
                    // 如果没有映射，清空模型列表（覆盖模式意味着完全替换）
                    finalModelsList = [];
                    console.log(`🔄 渠道 ${channel.id}: 使用覆盖模式，无映射时清空模型列表`);
                }
            } else {
                // 追加模式（默认）：原始模型 + 映射后的模型 + 映射的原始模型
                finalModelsList = [...originalModels];

                if (Object.keys(relevantMapping).length > 0) {
                    // 添加映射后的模型名称（键）和原始模型名称（值）
                    const mappedModels = Object.keys(relevantMapping);
                    const sourceModels = Object.values(relevantMapping);
                    finalModelsList.push(...mappedModels);
                    finalModelsList.push(...sourceModels);  // 确保原始模型也在列表中
                    console.log(`🔄 渠道 ${channel.id}: 使用追加模式，原始 ${originalModels.length} 个 + 映射 ${mappedModels.length} 个 + 源模型 ${sourceModels.length} 个`);
                }

                // 去重并保持顺序
                finalModelsList = [...new Set(finalModelsList)];
            }

            // 更新渠道 - 保留原有的 model_mapping 字段，只更新模型列表
            const updateData = {
                ...channel,  // 保留所有原有字段
                models: finalModelsList.join(',')  // 只更新模型列表
            };

            // 处理 model_mapping 字段
            if (modelUpdateMode === 'append') {
                // 追加模式：总是处理现有映射
                let existingMapping = {};

                // 解析现有映射
                if (channel.model_mapping) {
                    try {
                        existingMapping = JSON.parse(channel.model_mapping);
                        console.log(`🔄 渠道 ${channel.id}: 追加模式，发现现有映射规则 ${Object.keys(existingMapping).length} 个`);
                    } catch (e) {
                        console.log(`⚠️ 渠道 ${channel.id}: 解析现有映射失败，使用空映射`);
                        existingMapping = {};
                    }
                }

                if (Object.keys(relevantMapping).length > 0) {
                    // 有新映射时：智能合并现有映射 + 新映射（仅限当前渠道相关的映射）
                    const combinedMapping = { ...existingMapping };

                    // 处理映射合并：只添加与当前渠道相关的新映射
                    Object.entries(relevantMapping).forEach(([sourceKey, targetValue]) => {
                        if (combinedMapping[sourceKey]) {
                            // 如果键已存在且值相同，跳过
                            if (combinedMapping[sourceKey] === targetValue) {
                                console.log(`⏭️ 渠道 ${channel.id}: 映射已存在且相同，跳过: ${sourceKey} → ${targetValue}`);
                            } else {
                                // 键存在但值不同，更新为新值
                                const oldValue = combinedMapping[sourceKey];
                                combinedMapping[sourceKey] = targetValue;
                                console.log(`🔄 渠道 ${channel.id}: 更新映射: ${sourceKey} → ${targetValue} (原值: ${oldValue})`);
                            }
                        } else {
                            // 新键，直接添加
                            combinedMapping[sourceKey] = targetValue;
                            console.log(`✅ 渠道 ${channel.id}: 新增映射: ${sourceKey} → ${targetValue}`);
                        }
                    });

                    updateData.model_mapping = JSON.stringify(combinedMapping);
                    console.log(`🔄 渠道 ${channel.id}: 合并后共 ${Object.keys(combinedMapping).length} 个映射规则`);
                } else {
                    // 没有新映射时：保留现有映射不变
                    updateData.model_mapping = channel.model_mapping;
                    console.log(`🔄 渠道 ${channel.id}: 无新映射，保留现有映射规则 ${Object.keys(existingMapping).length} 个`);
                }
            } else {
                // 覆盖模式：完全替换（仅使用当前渠道相关的映射）
                if (Object.keys(relevantMapping).length > 0) {
                    updateData.model_mapping = JSON.stringify(relevantMapping);
                    console.log(`🔄 渠道 ${channel.id}: 覆盖模式，设置 ${Object.keys(relevantMapping).length} 个映射规则`);
                } else {
                    // 覆盖模式且没有相关映射时：清空映射
                    updateData.model_mapping = null;
                    console.log(`🔄 渠道 ${channel.id}: 覆盖模式，清空映射规则`);
                }
            }

            console.log(`🔄 更新渠道 ${channel.id} (${channel.name})`);
            console.log(`📊 原始模型: ${originalModels.length} 个`);
            console.log(`📊 相关映射: ${Object.keys(relevantMapping).length} 个规则`);
            console.log(`📊 更新后模型: ${finalModelsList.length} 个`);
            if (mappingChanges.length > 0) {
                console.log(`📊 映射规则: ${mappingChanges.slice(0, 5).join(', ')}${mappingChanges.length > 5 ? '...' : ''}`);
            }

            const updateResult = await this.updateChannel(updateData);

            if (updateResult.success) {
                return {
                    channelId: channel.id,
                    channelName: channel.name,
                    success: true,
                    action: 'updated',
                    changedCount: Object.keys(relevantMapping).length,
                    totalModels: originalModels.length,
                    mappingRules: mappingChanges,
                    changes: mappingChanges.join(', ')
                };
            } else {
                return {
                    channelId: channel.id,
                    channelName: channel.name,
                    success: false,
                    action: 'error',
                    error: updateResult.message
                };
            }
        } catch (error) {
            console.error(`❌ 处理渠道 ${channel.id} 失败:`, error);
            return {
                channelId: channel.id,
                channelName: channel.name,
                success: false,
                action: 'error',
                error: error.message
            };
        }
    }

    // 生成同步建议
    generateSyncSuggestions(error) {
        const suggestions = [];
        
        if (error.code === 'ECONNREFUSED') {
            suggestions.push('检查NewAPI服务器是否正常运行');
            suggestions.push('确认网络连接正常');
        } else if (error.code === 'ETIMEDOUT') {
            suggestions.push('请求超时，尝试减少每批处理的渠道数量');
            suggestions.push('检查网络延迟和服务器响应时间');
        } else if (error.response?.status === 401) {
            suggestions.push('检查访问令牌是否有效');
            suggestions.push('确认用户ID和认证类型设置正确');
        } else if (error.response?.status === 403) {
            suggestions.push('检查用户权限是否足够');
            suggestions.push('确认是否有渠道更新权限');
        } else if (error.response?.status === 429) {
            suggestions.push('API请求过于频繁，请降低请求频率');
            suggestions.push('增加批次间的延迟时间');
        } else if (error.message?.includes('validation')) {
            suggestions.push('检查模型映射格式是否正确');
            suggestions.push('确认模型名称符合NewAPI要求');
        }
        
        return suggestions;
    }

    // 获取认证头部类型
    getAuthHeaderType(authType) {
        const authTypes = {
            'NEW_API': 'New-Api-User',
            'VELOERA': 'Veloera-User'
        };
        return authTypes[authType] || 'New-Api-User';
    }

    // 生成模型重定向映射
    generateModelMapping(standardModels, actualModels) {
        if (!standardModels || !actualModels || standardModels.length === 0 || actualModels.length === 0) {
            return {};
        }

        const modelMap = {};

        for (const standardModel of standardModels) {
            // 如果实际模型列表已经精确包含标准模型，则不需要映射
            if (actualModels.includes(standardModel)) {
                continue;
            }

            // 寻找最相似的实际模型
            const bestMatch = this.findBestMatch(standardModel, actualModels);

            if (bestMatch) {
                console.log(`为标准模型 '${standardModel}' 找到最接近的匹配: '${bestMatch}'`);
                modelMap[standardModel] = bestMatch;
            } else {
                console.warn(`无法为标准模型 '${standardModel}' 找到任何匹配项`);
            }
        }

        return modelMap;
    }

    // 寻找最佳匹配 - 优化版本（严格模式，减少误判）
    findBestMatch(source, targets, options = {}) {
        if (!source || !targets || targets.length === 0) {
            return null;
        }

        const debug = Boolean((options && options.debug) ?? this.config?.debug);
        const sourceLower = source.toLowerCase();

        // 提取源模型的系列信息（用于防止跨系列误判）
        const sourceFamily = this.extractModelFamily(source);

        // 提取源模型的功能后缀（用于防止跨功能误匹配）
        const sourceFuncSuffix = this.extractFunctionalSuffix(source);

        // 多阶段匹配策略
        const matchResults = [];

        // 阶段1: 精确匹配（最高优先级）
        const exactMatch = targets.find(target => target.toLowerCase() === sourceLower);
        if (exactMatch) {
            matchResults.push({ match: exactMatch, score: 100, method: 'exact' });
        }

        // 阶段2: 智能前缀/后缀匹配（严格模式）
        const smartMatches = this.findSmartMatches(source, targets);
        // 功能后缀不匹配的降低分数而不是排除
        for (const m of smartMatches) {
            const targetFuncSuffix = this.extractFunctionalSuffix(m.match);
            if (sourceFuncSuffix !== targetFuncSuffix) {
                m.score = Math.max(m.score - 20, 50); // 降低20分，最低50分
            }
            matchResults.push(m);
        }

        // 阶段3: 包含匹配（带权重，增加系列校验）
        const containMatches = this.findWeightedContainMatches(source, targets);
        // 过滤掉跨系列的，功能后缀不匹配的降低分数
        for (const m of containMatches) {
            const targetFamily = this.extractModelFamily(m.match);
            if (!this.isSameModelFamily(sourceFamily, targetFamily)) continue;
            const targetFuncSuffix = this.extractFunctionalSuffix(m.match);
            if (sourceFuncSuffix !== targetFuncSuffix) {
                m.score = Math.max(m.score - 20, 50);
            }
            matchResults.push(m);
        }

        // 阶段4: 语义相似度匹配（增加系列校验）
        const semanticMatches = this.findSemanticMatches(source, targets);
        for (const m of semanticMatches) {
            const targetFamily = this.extractModelFamily(m.match);
            if (!this.isSameModelFamily(sourceFamily, targetFamily)) continue;
            const targetFuncSuffix = this.extractFunctionalSuffix(m.match);
            if (sourceFuncSuffix !== targetFuncSuffix) {
                m.score = Math.max(m.score - 20, 50);
            }
            matchResults.push(m);
        }

        // 阶段5: Levenshtein距离匹配（作为最后备选，提高门槛）
        const levenshteinMatches = this.findLevenshteinMatches(source, targets);
        for (const m of levenshteinMatches) {
            const targetFamily = this.extractModelFamily(m.match);
            if (!this.isSameModelFamily(sourceFamily, targetFamily)) continue;
            if (m.score < 50) continue;
            const targetFuncSuffix = this.extractFunctionalSuffix(m.match);
            if (sourceFuncSuffix !== targetFuncSuffix) {
                m.score = Math.max(m.score - 20, 50);
            }
            matchResults.push(m);
        }

        // 按分数排序并返回最佳匹配
        matchResults.sort((a, b) => b.score - a.score);

        // 提高最低分数门槛：从30提高到60，减少误判
        const minScore = 60;
        if (matchResults.length > 0 && matchResults[0].score >= minScore) {
            if (debug) {
                console.log(`🎯 为 '${source}' 找到匹配: '${matchResults[0].match}' (${matchResults[0].method}, 分数: ${matchResults[0].score})`);
            }
            return matchResults[0].match;
        }

        if (debug) {
            console.warn(`⚠️ 为 '${source}' 未找到合适的匹配 (最佳分数: ${matchResults[0]?.score || 0}, 门槛: ${minScore})`);
        }
        return null;
    }

    /**
     * 提取模型系列信息（用于防止跨系列误判）
     * 例如: gpt-4-turbo -> gpt-4, claude-3-opus -> claude-3
     */
    extractModelFamily(modelName) {
        if (!modelName) return { provider: '', series: '', version: '' };

        const lower = modelName.toLowerCase();

        // 定义模型系列模式
        const familyPatterns = [
            // OpenAI GPT 系列
            { pattern: /gpt-?4\.?1/i, provider: 'openai', series: 'gpt-4.1' },
            { pattern: /gpt-?4o/i, provider: 'openai', series: 'gpt-4o' },
            { pattern: /gpt-?4/i, provider: 'openai', series: 'gpt-4' },
            { pattern: /gpt-?3\.?5/i, provider: 'openai', series: 'gpt-3.5' },
            { pattern: /o1-?mini/i, provider: 'openai', series: 'o1-mini' },
            { pattern: /o1-?preview/i, provider: 'openai', series: 'o1-preview' },
            { pattern: /o1-?pro/i, provider: 'openai', series: 'o1-pro' },
            { pattern: /o3-?mini/i, provider: 'openai', series: 'o3-mini' },
            { pattern: /o3/i, provider: 'openai', series: 'o3' },
            // Anthropic Claude 系列
            { pattern: /claude-?4-?opus/i, provider: 'anthropic', series: 'claude-4-opus' },
            { pattern: /claude-?4-?sonnet/i, provider: 'anthropic', series: 'claude-4-sonnet' },
            { pattern: /claude-?4-?haiku/i, provider: 'anthropic', series: 'claude-4-haiku' },
            { pattern: /claude-?3\.?7/i, provider: 'anthropic', series: 'claude-3.7' },
            { pattern: /claude-?3\.?5/i, provider: 'anthropic', series: 'claude-3.5' },
            { pattern: /claude-?3-?opus/i, provider: 'anthropic', series: 'claude-3-opus' },
            { pattern: /claude-?3-?sonnet/i, provider: 'anthropic', series: 'claude-3-sonnet' },
            { pattern: /claude-?3-?haiku/i, provider: 'anthropic', series: 'claude-3-haiku' },
            { pattern: /claude-?3/i, provider: 'anthropic', series: 'claude-3' },
            { pattern: /claude-?2/i, provider: 'anthropic', series: 'claude-2' },
            // Google Gemini 系列
            { pattern: /gemini-?3-?pro/i, provider: 'google', series: 'gemini-3-pro' },
            { pattern: /gemini-?3-?flash/i, provider: 'google', series: 'gemini-3-flash' },
            { pattern: /gemini-?2\.?5-?pro/i, provider: 'google', series: 'gemini-2.5-pro' },
            { pattern: /gemini-?2\.?5-?flash/i, provider: 'google', series: 'gemini-2.5-flash' },
            { pattern: /gemini-?2\.?0/i, provider: 'google', series: 'gemini-2.0' },
            { pattern: /gemini-?1\.?5-?pro/i, provider: 'google', series: 'gemini-1.5-pro' },
            { pattern: /gemini-?1\.?5-?flash/i, provider: 'google', series: 'gemini-1.5-flash' },
            { pattern: /gemini-?pro/i, provider: 'google', series: 'gemini-pro' },
            // Meta Llama 系列
            { pattern: /llama-?3\.?3/i, provider: 'meta', series: 'llama-3.3' },
            { pattern: /llama-?3\.?2/i, provider: 'meta', series: 'llama-3.2' },
            { pattern: /llama-?3\.?1/i, provider: 'meta', series: 'llama-3.1' },
            { pattern: /llama-?3/i, provider: 'meta', series: 'llama-3' },
            { pattern: /llama-?2/i, provider: 'meta', series: 'llama-2' },
            // Mistral 系列
            { pattern: /mistral-?large/i, provider: 'mistral', series: 'mistral-large' },
            { pattern: /mistral-?medium/i, provider: 'mistral', series: 'mistral-medium' },
            { pattern: /mistral-?small/i, provider: 'mistral', series: 'mistral-small' },
            { pattern: /mixtral/i, provider: 'mistral', series: 'mixtral' },
            // DeepSeek 系列
            { pattern: /deepseek-?v3/i, provider: 'deepseek', series: 'deepseek-v3' },
            { pattern: /deepseek-?v2/i, provider: 'deepseek', series: 'deepseek-v2' },
            { pattern: /deepseek-?coder/i, provider: 'deepseek', series: 'deepseek-coder' },
            { pattern: /deepseek-?chat/i, provider: 'deepseek', series: 'deepseek-chat' },
            // Qwen 系列
            { pattern: /qwen-?2\.?5/i, provider: 'alibaba', series: 'qwen-2.5' },
            { pattern: /qwen-?2/i, provider: 'alibaba', series: 'qwen-2' },
            { pattern: /qwen-?max/i, provider: 'alibaba', series: 'qwen-max' },
            { pattern: /qwen-?plus/i, provider: 'alibaba', series: 'qwen-plus' },
        ];

        for (const { pattern, provider, series } of familyPatterns) {
            if (pattern.test(lower)) {
                return { provider, series, version: '' };
            }
        }

        // 未识别的模型，尝试提取基本信息
        const parts = lower.split(/[-_]/);
        return {
            provider: 'unknown',
            series: parts.slice(0, 2).join('-'),
            version: ''
        };
    }

    /**
     * 判断两个模型是否属于同一系列（防止跨系列误判）
     */
    isSameModelFamily(family1, family2) {
        // 如果任一方是未知系列，允许匹配（宽松模式）
        if (family1.provider === 'unknown' || family2.provider === 'unknown') {
            return true;
        }

        // 必须是同一提供商
        if (family1.provider !== family2.provider) {
            return false;
        }

        // 同一提供商内，检查系列是否兼容
        const series1 = family1.series;
        const series2 = family2.series;

        // 精确匹配
        if (series1 === series2) return true;

        // 检查是否是同一主系列的变体
        // 注意：pro 和 flash 是不同的产品线，不应该互相匹配
        // 只有 opus/sonnet/haiku 这类是同一产品线的不同规格
        const mainSeries1 = series1.replace(/-?(opus|sonnet|haiku|turbo|mini|nano|lite)$/i, '');
        const mainSeries2 = series2.replace(/-?(opus|sonnet|haiku|turbo|mini|nano|lite)$/i, '');

        return mainSeries1 === mainSeries2;
    }

    // 智能匹配：前缀、后缀、版本匹配
    findSmartMatches(source, targets) {
        const matches = [];
        const sourceLower = source.toLowerCase();
        const sourceFamily = this.extractModelFamily(source);

        for (const target of targets) {
            const targetLower = target.toLowerCase();

            // 系列校验：防止跨系列误判
            const targetFamily = this.extractModelFamily(target);
            if (!this.isSameModelFamily(sourceFamily, targetFamily)) {
                continue;
            }

            let score = 0;
            let method = '';

            // 前缀匹配
            if (targetLower.startsWith(sourceLower + '-') || targetLower.startsWith(sourceLower + '_')) {
                score = 85;
                method = 'prefix';
            }
            // 后缀匹配
            else if (targetLower.endsWith('-' + sourceLower) || targetLower.endsWith('_' + sourceLower)) {
                score = 80;
                method = 'suffix';
            }
            // 版本号匹配
            else if (this.isVersionMatch(sourceLower, targetLower)) {
                score = 90;
                method = 'version';
            }
            // 缩写匹配
            else if (this.isAbbreviationMatch(sourceLower, targetLower)) {
                score = 75;
                method = 'abbreviation';
            }

            if (score > 0) {
                // 降级保护
                if (!this.isPotentialDowngrade(sourceLower, targetLower)) {
                    matches.push({ match: target, score, method });
                }
            }
        }

        return matches;
    }

    // 加权包含匹配
    findWeightedContainMatches(source, targets) {
        const matches = [];
        const sourceLower = source.toLowerCase();
        
        for (const target of targets) {
            const targetLower = target.toLowerCase();
            
            if (targetLower.includes(sourceLower)) {
                let score = 60;
                
                // 计算包含位置权重
                const index = targetLower.indexOf(sourceLower);
                if (index === 0) score += 10; // 开头包含
                if (index === targetLower.length - sourceLower.length) score += 5; // 结尾包含
                
                // 计算长度相似度
                const lengthRatio = sourceLower.length / targetLower.length;
                if (lengthRatio > 0.7) score += 15; // 长度相似
                
                if (!this.isPotentialDowngrade(sourceLower, targetLower)) {
                    matches.push({ match: target, score, method: 'contain' });
                }
            }
        }
        
        return matches;
    }

    // 语义相似度匹配
    findSemanticMatches(source, targets) {
        const matches = [];
        const sourceLower = source.toLowerCase();
        
        for (const target of targets) {
            const targetLower = target.toLowerCase();
            
            // 提取关键词
            const sourceKeywords = this.extractKeywords(sourceLower);
            const targetKeywords = this.extractKeywords(targetLower);
            
            // 计算关键词重叠度
            const intersection = sourceKeywords.filter(k => targetKeywords.includes(k));
            const union = [...new Set([...sourceKeywords, ...targetKeywords])];
            const jaccardSimilarity = intersection.length / union.length;
            
            if (jaccardSimilarity > 0.3) {
                const score = Math.round(jaccardSimilarity * 50);
                if (!this.isPotentialDowngrade(sourceLower, targetLower)) {
                    matches.push({ match: target, score, method: 'semantic' });
                }
            }
        }
        
        return matches;
    }

    // Levenshtein距离匹配
    findLevenshteinMatches(source, targets) {
        const matches = [];
        const sourceLower = source.toLowerCase();
        
        for (const target of targets) {
            const targetLower = target.toLowerCase();
            const distance = this.calculateLevenshteinDistance(sourceLower, targetLower);
            const maxDistance = Math.max(sourceLower.length, targetLower.length);
            const similarity = 1 - (distance / maxDistance);
            
            if (similarity > 0.5) {
                const score = Math.round(similarity * 40);
                if (!this.isPotentialDowngrade(sourceLower, targetLower)) {
                    matches.push({ match: target, score, method: 'levenshtein' });
                }
            }
        }
        
        return matches;
    }

    // 检查是否为降级匹配
    isPotentialDowngrade(source, target) {
        return target.startsWith(source) &&
               target.length > source.length &&
               (target.endsWith('-mini') || target.endsWith('-nano') || 
                target.endsWith('-lite') || target.endsWith('-small'));
    }

    // 检查版本号匹配
    isVersionMatch(source, target) {
        const sourceVersion = source.match(/\d+/g);
        const targetVersion = target.match(/\d+/g);
        
        if (sourceVersion && targetVersion) {
            // 检查主要版本号是否匹配
            return sourceVersion[0] === targetVersion[0];
        }
        return false;
    }

    // 检查缩写匹配
    isAbbreviationMatch(source, target) {
        // 生成目标字符串的缩写
        const words = target.split(/[-_\s]/);
        const abbreviation = words.map(word => word[0]).join('').toLowerCase();
        
        return source === abbreviation || abbreviation.includes(source);
    }

    // 提取关键词
    extractKeywords(text) {
        return text.split(/[-_\s\d]/).filter(word => word.length > 2);
    }

    // 计算Levenshtein距离
    calculateLevenshteinDistance(s1, s2) {
        s1 = s1.toLowerCase();
        s2 = s2.toLowerCase();

        const matrix = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));

        for (let i = 0; i <= s1.length; i++) {
            matrix[0][i] = i;
        }

        for (let j = 0; j <= s2.length; j++) {
            matrix[j][0] = j;
        }

        for (let j = 1; j <= s2.length; j++) {
            for (let i = 1; i <= s1.length; i++) {
                const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
                matrix[j][i] = Math.min(
                    matrix[j][i - 1] + 1,
                    matrix[j - 1][i] + 1,
                    matrix[j - 1][i - 1] + indicator
                );
            }
        }

        return matrix[s2.length][s1.length];
    }

    // ==================== 用户规则引擎 ====================

    /**
     * 设置用户规则
     * @param {Object} rules - 规则对象 { nameMatch: [], merge: [], custom: [] }
     */
    setUserRules(rules) {
        if (!rules || typeof rules !== 'object') {
            console.log('⚠️ 无效的规则对象，使用空规则');
            this.userRules = { nameMatch: [], merge: [], custom: [] };
            return;
        }

        this.userRules = {
            nameMatch: Array.isArray(rules.nameMatch) ? rules.nameMatch : [],
            merge: Array.isArray(rules.merge) ? rules.merge : [],
            custom: Array.isArray(rules.custom) ? rules.custom : []
        };

        const totalRules = this.userRules.nameMatch.length +
                          this.userRules.merge.length +
                          this.userRules.custom.length;

        console.log(`📋 已加载用户规则: 名称匹配 ${this.userRules.nameMatch.length}, 合并 ${this.userRules.merge.length}, 自定义 ${this.userRules.custom.length} (共 ${totalRules} 条)`);
    }

    /**
     * 应用单个自定义规则到模型名
     * @param {string} modelName - 模型名称
     * @param {Object} rule - 规则对象
     * @returns {string} 处理后的模型名
     */
    applyCustomRule(modelName, rule) {
        if (!rule || !rule.enabled) return modelName;

        // 检查应用条件
        if (rule.condition && rule.condition !== 'all') {
            const conditionValue = rule.conditionValue || '';
            let shouldApply = false;

            switch (rule.condition) {
                case 'startswith':
                    shouldApply = modelName.startsWith(conditionValue);
                    break;
                case 'endswith':
                    shouldApply = modelName.endsWith(conditionValue);
                    break;
                case 'contains':
                    shouldApply = modelName.includes(conditionValue);
                    break;
                default:
                    shouldApply = true;
            }

            if (!shouldApply) {
                return modelName;
            }
        }

        switch (rule.type) {
            case 'regex':
                try {
                    const regex = new RegExp(rule.pattern, rule.flags || 'gi');
                    return modelName.replace(regex, rule.replacement || '');
                } catch (e) {
                    console.warn(`   ❌ 正则表达式错误: ${e.message}`);
                    return modelName;
                }

            case 'string':
                return modelName.split(rule.pattern).join(rule.replacement || '');

            case 'prefix':
                if (modelName.startsWith(rule.pattern)) {
                    return (rule.replacement || '') + modelName.slice(rule.pattern.length);
                }
                return modelName;

            case 'suffix':
                if (modelName.endsWith(rule.pattern)) {
                    return modelName.slice(0, -rule.pattern.length) + (rule.replacement || '');
                }
                return modelName;

            default:
                return modelName;
        }
    }

    /**
     * 应用名称匹配规则
     * @param {string} modelName - 模型名称
     * @returns {string} 匹配后的标准名称
     */
    applyNameMatchRules(modelName) {
        // 首先检查用户定义的精确匹配规则
        for (const rule of this.userRules.nameMatch) {
            if (!rule.enabled) continue;
            if (rule.source === modelName) {
                console.log(`   🎯 名称匹配规则命中: "${modelName}" → "${rule.target}"`);
                return rule.target;
            }
        }
        return modelName;
    }

    /**
     * 应用所有用户规则到模型名
     * @param {string} modelName - 原始模型名
     * @returns {Object} { result: 处理后的名称, matched: 是否有规则命中, method: 命中的方法 }
     */
    applyUserRules(modelName) {
        if (!modelName) return { result: modelName, matched: false, method: null };

        let result = modelName;
        let matched = false;
        let method = null;

        const debug = this.config.debug;

        // 1. 首先应用自定义规则（按优先级排序）
        const sortedCustomRules = [...this.userRules.custom]
            .filter(r => r.enabled)
            .sort((a, b) => (b.priority || 0) - (a.priority || 0));

        for (const rule of sortedCustomRules) {
            const before = result;
            result = this.applyCustomRule(result, rule);
            if (before !== result) {
                matched = true;
                method = `custom-${rule.type}`;
                if (debug) {
                    console.log(`   ✅ 自定义规则命中 (${rule.type}): "${before}" → "${result}"`);
                }
                // 继续应用其他规则，允许规则叠加
            }
        }

        // 2. 应用名称匹配规则
        const beforeNameMatch = result;
        result = this.applyNameMatchRules(result);
        if (beforeNameMatch !== result) {
            matched = true;
            method = 'name-match';
        }

        return { result, matched, method };
    }

    /**
     * 使用用户规则寻找模型匹配
     * 优先使用用户规则，如果没有匹配再使用智能算法
     * @param {string} originalModel - 原始模型名
     * @param {Array} currentModels - 当前可用模型列表
     * @param {Object} existingMapping - 现有映射
     * @param {Object} options - 选项
     * @returns {Object|null} 匹配结果
     */
    findMatchWithUserRules(originalModel, currentModels, existingMapping = {}, options = {}) {
        const debug = Boolean((options && options.debug) ?? this.config?.debug);
        const console = debug ? globalThis.console : { log: () => {}, warn: () => {} };

        // 1. 首先应用用户规则转换模型名
        const { result: transformedName, matched: ruleMatched, method: ruleMethod } = this.applyUserRules(originalModel);

        if (ruleMatched && transformedName !== originalModel) {
            console.log(`🔧 用户规则转换: "${originalModel}" → "${transformedName}" (${ruleMethod})`);

            // 检查转换后的名称是否在当前模型列表中
            const transformedLower = transformedName.toLowerCase();
            const exactMatch = currentModels.find(m => String(m).toLowerCase() === transformedLower);

            if (exactMatch) {
                console.log(`✅ 转换后精确匹配: "${transformedName}" = "${exactMatch}"`);
                return { match: exactMatch, score: 100, method: `rule-${ruleMethod}` };
            }

            // 转换后的名称不在列表中，但我们仍然可以使用它作为标准名称
            // 然后在当前模型中寻找最接近的实际模型
            console.log(`🔍 转换后名称 "${transformedName}" 不在模型列表中，继续智能匹配...`);
        }

        // 2. 如果用户规则没有完全解决，使用智能匹配算法
        return this.findBestMatchForRenamedModel(originalModel, currentModels, existingMapping, options);
    }

    // 获取标准模型列表 - 基于 gpt-api-sync 的实现
    getStandardModels() {
        return [
            'gpt-4o',
            'gpt-4o-mini', 
            'gpt-4.1-nano',
            'gpt-4.1-mini',
            'gpt-4.1',
            'claude-4-opus',
            'claude-4-sonnet', 
            'claude-4-haiku',
            'claude-3.7-sonnet',
            'gemini-2.5-flash-lite',
            'gemini-2.5-flash',
            'gemini-2.5-pro'
        ];
    }

    // 生成智能模型映射 - 基于 gpt-api-sync 的智能匹配算法
    generateSmartModelMapping(standardModels, actualModels) {
        if (!standardModels || !actualModels || standardModels.length === 0 || actualModels.length === 0) {
            return {};
        }

        const modelMap = {};
        console.log(`🔍 开始智能模型映射: ${standardModels.length} 个标准模型 → ${actualModels.length} 个实际模型`);

        for (const standardModel of standardModels) {
            // 如果实际模型列表已经精确包含标准模型，则不需要映射
            if (actualModels.includes(standardModel)) {
                console.log(`✅ 标准模型 '${standardModel}' 已存在，无需映射`);
                continue;
            }

            // 使用智能匹配算法寻找最佳匹配
            const bestMatch = this.findBestMatch(standardModel, actualModels);

            if (bestMatch) {
                console.log(`🎯 为标准模型 '${standardModel}' 找到最接近的匹配: '${bestMatch}'`);
                modelMap[standardModel] = bestMatch;
            } else {
                console.warn(`⚠️ 无法为标准模型 '${standardModel}' 找到任何匹配项`);
            }
        }

        console.log(`🎯 智能映射完成，生成 ${Object.keys(modelMap).length} 个映射关系`);
        return modelMap;
    }

    // 调试API接口
    async debugAPIEndpoints() {
        console.log('🔍 开始调试 NewAPI 接口...');
        
        const endpoints = [
            '/api/models',
            '/api/model/list', 
            '/api/model',
            '/api/models/list',
            '/api/channel',
            '/api/status',
            '/api/health',
            '/'
        ];
        
        const results = [];
        
        for (const endpoint of endpoints) {
            try {
                console.log(`📡 测试接口: ${endpoint}`);
                const response = await this.client.get(endpoint, { timeout: 8000 });
                
                if (response.status === 200) {
                    console.log(`✅ ${endpoint} - 成功`);
                    const hasModels = this.extractModelsFromResponse(response.data).length > 0;
                    results.push({
                        endpoint,
                        status: 'success',
                        data: response.data,
                        hasModels: hasModels
                    });
                } else {
                    console.log(`❌ ${endpoint} - HTTP ${response.status}`);
                    results.push({
                        endpoint,
                        status: 'error',
                        error: `HTTP ${response.status}`
                    });
                }
            } catch (error) {
                console.log(`❌ ${endpoint} - ${error.message}`);
                results.push({
                    endpoint,
                    status: 'error',
                    error: error.message
                });
            }
        }
        
        const workingEndpoints = results.filter(r => r.status === 'success').length;
        console.log(`\n📊 调试结果: ${workingEndpoints}/${endpoints.length} 个接口可用`);
        
        return {
            success: true,
            results: results,
            summary: {
                total: endpoints.length,
                working: workingEndpoints,
                successRate: Math.round((workingEndpoints / endpoints.length) * 100)
            }
        };
    }
    
    checkIfHasModels(data) {
        if (!data) return false;
        
        // 检查各种可能的模型数据结构
        if (Array.isArray(data)) return data.length > 0;
        if (data.data && Array.isArray(data.data)) return data.data.length > 0;
        if (data.models && Array.isArray(data.models)) return data.models.length > 0;
        if (data.items && Array.isArray(data.items)) return data.items.length > 0;
        if (typeof data.models === 'string') return data.models.trim().length > 0;
        
        return false;
    }

    // ==================== 一键更新模型功能 ====================

    /**
     * 一键更新模型 - 核心功能
     * 基于NewAPI中已选择的模型，自动检测渠道商改名的模型并修复映射
     *
     * @param {Array} channelIds - 可选，指定要更新的渠道ID列表
     * @param {Object} options - 配置选项
     * @param {Object} options.rules - 用户规则 { nameMatch: [], merge: [], custom: [] }
     * @returns {Object} 更新结果
     */
    async oneClickUpdateModels(channelIds = null, options = {}) {
        const startTime = Date.now();
        const logs = [];
        const results = {
            scannedChannels: 0,
            updatedChannels: 0,
            fixedMappings: 0,
            brokenMappings: [],
            newMappings: [],
            errors: []
        };

        // 加载用户规则
        if (options.rules) {
            this.setUserRules(options.rules);
            logs.push(`📋 已加载用户规则: 名称匹配 ${this.userRules.nameMatch.length}, 合并 ${this.userRules.merge.length}, 自定义 ${this.userRules.custom.length}`);
        } else {
            logs.push('⚠️ 未提供用户规则，将仅使用智能匹配算法');
        }

        const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false;
        const pushLog = (message, type = 'info') => {
            logs.push(message);
            if (typeof options.onLog === 'function') {
                try {
                    options.onLog(message, type);
                } catch (e) {
                    // ignore
                }
            }
        };

        const reportProgress = (payload) => {
            if (typeof options.onProgress === 'function') {
                try {
                    options.onProgress(payload);
                } catch (e) {
                    // ignore
                }
            }
        };

        try {
            pushLog('🚀 开始一键更新模型...');
            pushLog('📋 步骤1: 获取所有渠道信息');

            // 1. 获取渠道列表
            let channels = [];
            if (channelIds && Array.isArray(channelIds) && channelIds.length > 0) {
                pushLog(`🎯 指定更新 ${channelIds.length} 个渠道`);
                const allChannelsResult = await this.getChannels(1, 1000);
                if (!allChannelsResult.success) {
                    throw new Error(`获取渠道失败: ${allChannelsResult.message}`);
                }
                const normalizedIds = channelIds.map(id => String(id));
                channels = allChannelsResult.data.filter(ch => normalizedIds.includes(String(ch.id)));
            } else {
                const channelsResult = await this.getChannels(1, 1000);
                if (!channelsResult.success) {
                    throw new Error(`获取渠道失败: ${channelsResult.message}`);
                }
                channels = channelsResult.data;
            }

            // 默认只处理启用渠道（可通过 options.onlyEnabled = false 覆盖）
            const onlyEnabled = options.onlyEnabled !== false;
            if (onlyEnabled) {
                channels = channels.filter(ch => ch && ch.status === 1);
            }

            pushLog(`✅ 获取到 ${channels.length} 个渠道${onlyEnabled ? '（已过滤禁用渠道）' : ''}`);
            results.scannedChannels = channels.length;

            if (channels.length === 0) {
                const duration = Date.now() - startTime;
                pushLog(`🏁 一键更新完成 - 扫描: 0, 更新: 0, 修复映射: 0, 耗时: ${duration}ms`);
                return {
                    success: true,
                    message: options.dryRun ? '预览分析完成' : '一键更新完成',
                    logs,
                    results,
                    duration
                };
            }

            // 2. 遍历每个渠道，分析模型变化
            pushLog('📋 步骤2: 分析各渠道模型变化');

            const maxConcurrencyRaw = Number(options.concurrency ?? options.maxConcurrency);
            const maxConcurrency = Number.isFinite(maxConcurrencyRaw)
                ? Math.max(1, Math.min(10, Math.floor(maxConcurrencyRaw)))
                : 4;

            const total = channels.length;
            let processed = 0;
            reportProgress({ stage: options.dryRun ? 'preview' : 'execute', current: 0, total, percent: 0 });

            let nextIndex = 0;
            const worker = async () => {
                while (true) {
                    if (shouldAbort()) return;

                    const index = nextIndex;
                    nextIndex++;
                    if (index >= total) return;

                    const channel = channels[index];
                    const channelName = channel?.name || String(channel?.id || '');

                    try {
                        const channelResult = await this.analyzeChannelModelChanges(channel, options);

                        if (channelResult.hasChanges) {
                            const isRemoval = (m) => m && (m.action === 'delete' || m.removeModel || m.fixType === 'remove-invalid');
                            // 过滤有效的可修复映射（删除项或 actualName 不为空且源不等于目标）
                            const validNewMappings = channelResult.newMappings.filter(m => {
                                if (isRemoval(m)) return true;
                                if (!m.actualName) return false;
                                const source = (m.originalModel || m.standardName || '').toLowerCase();
                                const target = (m.actualName || '').toLowerCase();
                                return source !== target;
                            });

                            // 只有真正有失效映射时才输出日志
                            if (channelResult.brokenMappings.length > 0) {
                                pushLog(`🔍 渠道 "${channelName}" 发现 ${channelResult.brokenMappings.length} 个失效映射`);
                            }

                            channelResult.brokenMappings.forEach(mapping => {
                                results.brokenMappings.push({
                                    channelId: channel.id,
                                    channelName: channel.name,
                                    ...mapping
                                });
                            });

                            channelResult.newMappings.forEach(mapping => {
                                results.newMappings.push({
                                    channelId: channel.id,
                                    channelName: channel.name,
                                    ...mapping
                                });
                            });

                            if (validNewMappings.length > 0 && !options.dryRun && !shouldAbort()) {
                                const updateResult = await this.applyModelMappingFix(channel, channelResult, options);
                                if (updateResult.success) {
                                    results.updatedChannels++;
                                    results.fixedMappings += validNewMappings.length;
                                    pushLog(`✅ 渠道 "${channelName}" 更新成功，修复 ${validNewMappings.length} 个映射`, 'success');
                                } else {
                                    results.errors.push({
                                        channelId: channel.id,
                                        channelName: channel.name,
                                        error: updateResult.message
                                    });
                                    pushLog(`❌ 渠道 "${channelName}" 更新失败: ${updateResult.message}`, 'error');
                                }
                            } else if (options.dryRun && validNewMappings.length > 0) {
                                pushLog(`🔎 [预览模式] 渠道 "${channelName}" 可修复 ${validNewMappings.length} 个映射`);
                            }
                        }
                    } catch (error) {
                        results.errors.push({
                            channelId: channel?.id,
                            channelName: channel?.name,
                            error: error.message
                        });
                        pushLog(`❌ 处理渠道 "${channelName}" 失败: ${error.message}`, 'error');
                    } finally {
                        processed++;
                        const percent = Math.round((processed / total) * 100);
                        reportProgress({
                            stage: options.dryRun ? 'preview' : 'execute',
                            current: processed,
                            total,
                            percent,
                            channelId: channel?.id,
                            channelName: channel?.name
                        });
                    }
                }
            };

            const workerCount = Math.min(maxConcurrency, total);
            await Promise.all(Array.from({ length: workerCount }, worker));

            if (shouldAbort()) {
                const duration = Date.now() - startTime;
                pushLog(`⏹️ 一键更新已取消 - 已处理: ${processed}/${total}, 更新: ${results.updatedChannels}, 修复映射: ${results.fixedMappings}, 耗时: ${duration}ms`, 'warning');
                return {
                    success: false,
                    cancelled: true,
                    message: '已取消',
                    logs,
                    results,
                    duration
                };
            }

            const duration = Date.now() - startTime;
            pushLog(`🏁 一键更新完成 - 扫描: ${results.scannedChannels}, 更新: ${results.updatedChannels}, 修复映射: ${results.fixedMappings}, 耗时: ${duration}ms`);

            return {
                success: true,
                message: options.dryRun ? '预览分析完成' : '一键更新完成',
                logs,
                results,
                duration
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            pushLog(`❌ 一键更新失败: ${error.message}`, 'error');

            return {
                success: false,
                message: error.message,
                logs,
                results,
                duration
            };
        }
    }

    /**
     * 获取渠道商实际提供的模型列表
     * 专门使用 fetch_models 端点获取渠道商的实际模型（非NewAPI配置的模型）
     *
     * @param {string|number} channelId - 渠道ID
     * @returns {Object} 包含实际模型列表的结果
     */
    async fetchActualProviderModels(channelId, options = {}) {
        const debug = Boolean((options && options.debug) ?? this.config?.debug);
        const console = debug ? globalThis.console : { log: () => {}, warn: () => {}, error: () => {} };

        const cacheKey = `provider_models_${channelId}`;
        const cacheContext = {
            baseUrl: this.config.baseUrl,
            token: this.config.token,
            userId: this.config.userId,
            authHeaderType: this.config.authHeaderType,
            channelId
        };
        const forceRefresh = Boolean(options && options.forceRefresh);
        if (forceRefresh) {
            this.deleteCache(cacheKey);
            sharedModelCache.deleteProviderModels(cacheContext);
        } else {
            const sharedCached = sharedModelCache.getProviderModels(cacheContext);
            if (sharedCached && Array.isArray(sharedCached) && sharedCached.length > 0) {
                return { success: true, data: sharedCached, source: 'shared-cache' };
            }
            const cached = this.getCache(cacheKey);
            if (cached && Array.isArray(cached) && cached.length > 0) {
                return { success: true, data: cached, source: 'cache' };
            }
        }

        console.log(`🔍 [DEBUG] fetchActualProviderModels 开始 - 渠道ID: ${channelId}`);

        // 必须使用 fetch_models 端点 - 这是唯一返回渠道商实际模型的端点
        const fetchModelsEndpoint = `/api/channel/fetch_models/${channelId}`;

        try {
            console.log(`📡 [DEBUG] 调用端点: ${fetchModelsEndpoint}`);
            const response = await this.retryWithBackoff(() =>
                this.client.get(fetchModelsEndpoint, { timeout: 15000 })
            );

            console.log(`📡 [DEBUG] 响应状态: ${response.status}`);
            console.log(`📡 [DEBUG] 响应数据类型: ${typeof response.data}`);
            console.log(`📡 [DEBUG] 响应数据预览: ${JSON.stringify(response.data).substring(0, 500)}`);

            if (response.status === 200) {
                const data = response.data;

                // 解析响应数据 - 支持多种格式
                let models = [];

                if (data && data.success && Array.isArray(data.data)) {
                    // 标准格式: { success: true, data: [...] }
                    console.log(`📡 [DEBUG] 匹配格式: 标准格式 { success: true, data: [...] }`);
                    models = data.data;
                } else if (Array.isArray(data)) {
                    // 直接数组格式
                    console.log(`📡 [DEBUG] 匹配格式: 直接数组格式`);
                    models = data;
                } else if (data && data.data && Array.isArray(data.data)) {
                    // 嵌套格式: { data: [...] }
                    console.log(`📡 [DEBUG] 匹配格式: 嵌套格式 { data: [...] }`);
                    models = data.data;
                } else if (data && data.models) {
                    // models 字段格式: { models: [...] } 或 { models: "a,b,c" }
                    console.log(`📡 [DEBUG] 匹配格式: models 字段格式`);
                    models = this.parseModels(data.models);
                } else if (data && data.result && Array.isArray(data.result)) {
                    // result 字段格式: { result: [...] }
                    console.log(`📡 [DEBUG] 匹配格式: result 字段格式`);
                    models = data.result;
                } else if (data && typeof data === 'object') {
                    // 尝试从对象中提取数组字段
                    const arrayFields = Object.keys(data).filter(key => Array.isArray(data[key]) && data[key].length > 0);
                    if (arrayFields.length > 0) {
                        const firstField = arrayFields[0];
                        console.log(`📡 [DEBUG] 匹配格式: 从 ${firstField} 字段提取数组`);
                        models = data[firstField];
                    } else {
                        console.log(`📡 [DEBUG] 未匹配任何已知格式!`);
                        console.log(`📡 [DEBUG] data.success = ${data?.success}, typeof data.data = ${typeof data?.data}`);
                    }
                } else {
                    console.log(`📡 [DEBUG] 未匹配任何已知格式!`);
                    console.log(`📡 [DEBUG] Array.isArray(data) = ${Array.isArray(data)}`);
                }

                console.log(`📡 [DEBUG] 解析后模型数量(清理前): ${models.length}`);
                if (models.length > 0) {
                    console.log(`📡 [DEBUG] 模型样本(清理前): ${JSON.stringify(models.slice(0, 3))}`);
                }

                // 清理模型名称
                models = models
                    .map(m => typeof m === 'string' ? m.trim() : (m.id || m.name || m))
                    .filter(m => m && typeof m === 'string' && m.length > 0);
                models = Array.from(new Set(models));

                console.log(`📡 [DEBUG] 解析后模型数量(清理后): ${models.length}`);

                if (models.length > 0) {
                    console.log(`✅ [DEBUG] 获取到渠道商实际模型 ${models.length} 个`);
                    console.log(`📋 [DEBUG] 前10个模型: ${models.slice(0, 10).join(', ')}`);
                    this.setCache(cacheKey, models);
                    sharedModelCache.setProviderModels(cacheContext, models);
                    return {
                        success: true,
                        data: models,
                        source: 'fetch_models'
                    };
                } else {
                    console.warn(`⚠️ [DEBUG] 清理后模型列表为空!`);
                }
            }

            console.warn(`⚠️ [DEBUG] fetch_models 端点未返回有效数据 - 状态码: ${response.status}`);
            return {
                success: false,
                data: [],
                message: 'fetch_models 端点未返回有效数据'
            };

        } catch (error) {
            console.error(`❌ [DEBUG] 获取渠道商实际模型失败: ${error.message}`);
            console.error(`❌ [DEBUG] 错误详情: ${error.stack}`);
            return {
                success: false,
                data: [],
                error: error.message
            };
        }
    }

    /**
     * 分析单个渠道的模型变化
     * @param {Object} channel - 渠道对象
     * @param {Object} options - 配置选项
     * @returns {Object} 分析结果
     */
    async analyzeChannelModelChanges(channel, options = {}) {
        const debug = Boolean((options && options.debug) ?? this.config?.debug);
        const console = debug ? globalThis.console : { log: () => {}, warn: () => {}, error: () => {} };

        console.log(`\n🔍 [DEBUG] ========== 分析渠道 ${channel.id} (${channel.name}) 模型变化 ==========`);

        const result = {
            hasChanges: false,
            brokenMappings: [],
            newMappings: [],
            currentModels: [],
            selectedModels: []
        };

        const includeUpgrades = Boolean(options.includeUpgrades);
        const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const replaceVersionInName = (name, oldVersionText, newVersionText) => {
            if (!name || !oldVersionText || !newVersionText || oldVersionText === newVersionText) return name;
            const escapedOld = escapeRegExp(oldVersionText);
            const direct = name.replace(new RegExp(escapedOld), newVersionText);
            if (direct !== name) return direct;
            return name.replace(/(\d+(?:\.\d+)*)/, newVersionText);
        };
        const normalizeActualForAlias = (name) => {
            if (!name) return '';
            let normalized = this.stripModelPrefix(name);
            if (!normalized) return '';
            normalized = normalized
                .replace(/(\[[^\]]+\]|【[^】]+】|\([^)]+\)|（[^）]+）)$/g, '')
                .replace(/[-_@#\/]+$/, '')
                .replace(/[-_./]+$/, '')
                .trim();
            return normalized;
        };
        const replaceSubstringIgnoreCase = (name, search, replacement) => {
            if (!name || !search || !replacement) return name;
            const escaped = escapeRegExp(search);
            const regex = new RegExp(escaped, 'i');
            if (!regex.test(name)) return name;
            return name.replace(regex, replacement);
        };
        const findBestMappingUpgrade = (aliasName, originalName, currentModels) => {
            const originalInfo = this.parseModelVersionInfo(originalName);
            if (!originalInfo) return null;

            const originalSuffix = String(originalInfo.suffix || '').toLowerCase();
            const originalFuncSuffix = this.extractFunctionalSuffix(originalName);
            let best = null;

            for (const currentModel of currentModels || []) {
                if (!currentModel || typeof currentModel !== 'string') continue;
                const info = this.parseModelVersionInfo(currentModel);
                if (!info) continue;
                if (info.base !== originalInfo.base) continue;
                if (!this.isVariantCompatible(originalInfo.variant, info.variant)) continue;
                if (String(info.suffix || '').toLowerCase() !== originalSuffix) continue;
                if (this.extractFunctionalSuffix(currentModel) !== originalFuncSuffix) continue;
                if (this.compareVersionParts(info.versionParts, originalInfo.versionParts) <= 0) continue;

                if (!best || this.compareVersionParts(info.versionParts, best.versionParts) > 0) {
                    best = { match: currentModel, versionParts: info.versionParts };
                }
            }

            if (!best) return null;
            const newVersionText = best.versionParts.join('.');
            const originalVersionText = originalInfo.versionParts.join('.');
            const updatedAlias = replaceVersionInName(aliasName, originalVersionText, newVersionText);

            if (!updatedAlias) return null;
            if (updatedAlias === aliasName && best.match === originalName) return null;

            return {
                newAlias: updatedAlias,
                newActual: best.match,
                score: 90,
                method: 'mapping-version-upgrade'
            };
        };
        const buildAliasForActualChange = (aliasName, originalName, newActualName) => {
            const safeAlias = String(aliasName || '').trim();
            const safeOriginal = String(originalName || '').trim();
            const safeNewActual = String(newActualName || '').trim();
            if (!safeAlias || !safeOriginal || !safeNewActual) return aliasName;

            const originalInfo = this.parseModelVersionInfo(safeOriginal);
            const newInfo = this.parseModelVersionInfo(safeNewActual);
            if (originalInfo && newInfo && originalInfo.base === newInfo.base) {
                const originalVersionText = originalInfo.versionParts.join('.');
                const newVersionText = newInfo.versionParts.join('.');
                const versionUpdated = replaceVersionInName(safeAlias, originalVersionText, newVersionText);
                if (versionUpdated && versionUpdated !== safeAlias) return versionUpdated;
            }

            const normalizedNewActual = normalizeActualForAlias(safeNewActual);
            if (!normalizedNewActual) return aliasName;
            if (normalizedNewActual.toLowerCase() === safeOriginal.toLowerCase()) return aliasName;

            let updated = replaceSubstringIgnoreCase(safeAlias, safeOriginal, normalizedNewActual);
            if (updated !== safeAlias) return updated;

            const strippedOriginal = this.stripModelPrefix(safeOriginal);
            if (strippedOriginal && strippedOriginal.toLowerCase() !== safeOriginal.toLowerCase()) {
                updated = replaceSubstringIgnoreCase(safeAlias, strippedOriginal, normalizedNewActual);
                if (updated !== safeAlias) return updated;
            }

            return aliasName;
        };

        // 获取渠道当前已选择的模型（来自NewAPI配置）
        const selectedModels = this.parseModelList(channel.models);
        result.selectedModels = selectedModels;

        console.log(`📋 [DEBUG] 已选择的模型数量: ${selectedModels.length}`);
        if (selectedModels.length > 0) {
            console.log(`📋 [DEBUG] 前10个已选择的模型: ${selectedModels.slice(0, 10).join(', ')}`);
        }

        if (selectedModels.length === 0) {
            console.log(`⏭️ [DEBUG] 渠道 ${channel.id} 无已选择模型，跳过`);
            return result;
        }

        // 获取渠道商实际提供的模型列表
        // 策略：
        // 1. 首先尝试 fetch_models 端点获取渠道商实际模型
        // 2. 如果失败，尝试使用 smartGetChannelModels 作为后备
        // 3. 如果都失败，使用已选择的模型作为基准进行分析（但标记为降级模式）
        let fetchSuccess = false;
        let usedFallback = false;

        try {
            console.log(`📡 [DEBUG] 开始获取渠道商实际模型...`);
            const actualModelsResult = await this.fetchActualProviderModels(channel.id, options);
            console.log(`📡 [DEBUG] fetchActualProviderModels 返回: success=${actualModelsResult.success}, data.length=${actualModelsResult.data?.length || 0}`);

            if (actualModelsResult.success && actualModelsResult.data.length > 0) {
                result.currentModels = actualModelsResult.data;
                fetchSuccess = true;
                console.log(`📦 [DEBUG] 渠道 ${channel.id} 渠道商实际模型: ${result.currentModels.length} 个`);
                console.log(`📋 [DEBUG] 前10个实际模型: ${result.currentModels.slice(0, 10).join(', ')}`);
            } else {
                console.warn(`⚠️ [DEBUG] fetch_models 返回空，尝试后备方案...`);
            }
        } catch (error) {
            console.warn(`❌ [DEBUG] fetch_models 失败: ${error.message}，尝试后备方案...`);
        }

        // 后备方案1: 使用 smartGetChannelModels
        if (!fetchSuccess) {
            try {
                console.log(`🔄 [DEBUG] 尝试后备方案: smartGetChannelModels`);
                const fallbackModels = await this.smartGetChannelModels(channel.id);
                if (fallbackModels && fallbackModels.length > 0) {
                    result.currentModels = fallbackModels;
                    fetchSuccess = true;
                    usedFallback = true;
                    console.log(`✅ [DEBUG] 后备方案成功，获取到 ${fallbackModels.length} 个模型`);
                }
            } catch (error) {
                console.warn(`❌ [DEBUG] 后备方案也失败: ${error.message}`);
            }
        }

        // 后备方案2: 使用已选择的模型进行自我比较（检测带前缀/后缀的变体）
        if (!fetchSuccess) {
            console.warn(`⚠️ [DEBUG] 所有获取方式都失败，使用降级模式`);
            console.warn(`⚠️ [DEBUG] 降级模式：将使用已选择的模型进行自分析`);

            // 在降级模式下，分析已选择的模型中是否存在带前缀/后缀的变体
            // 例如：如果选择了 "claude-opus-4" 和 "[反重力]claude-opus-4"，
            // 我们可以推断出标准名称和带前缀的版本之间的映射关系
            usedFallback = true;

            // 降级模式：在选择的模型中查找可能的前缀/后缀模型对
            console.log(`🔍 [DEBUG] 降级模式：分析 ${selectedModels.length} 个已选择模型中的命名模式`);

            // 找出带前缀/后缀的模型和可能的标准名称
            const prefixedModels = [];
            const standardModels = [];

            for (const model of selectedModels) {
                // 检查是否是带前缀的模型
                const stripped = this.extractCoreModelName(model);
                if (stripped !== model && stripped.length > 0) {
                    prefixedModels.push({ original: model, core: stripped });
                } else {
                    standardModels.push(model);
                }
            }

            console.log(`🔍 [DEBUG] 降级模式：发现 ${prefixedModels.length} 个带前缀/后缀的模型，${standardModels.length} 个标准模型`);

            // 检测并记录映射关系
            for (const prefixed of prefixedModels) {
                // 检查是否存在对应的标准模型
                const matchingStandard = standardModels.find(s =>
                    s.toLowerCase() === prefixed.core.toLowerCase()
                );

                if (!matchingStandard) {
                    // 标准模型不在已选择的模型中，这可能意味着需要添加映射
                    console.log(`🔍 [DEBUG] 降级模式：发现潜在映射 "${prefixed.core}" → "${prefixed.original}"`);

                    result.brokenMappings.push({
                        originalModel: prefixed.core,
                        expectedModel: prefixed.core,
                        reason: '标准模型名在渠道中可能被重命名'
                    });

                    result.newMappings.push({
                        standardName: prefixed.core,
                        actualName: prefixed.original,
                        originalModel: prefixed.original,
                        confidence: 90,
                        method: 'degraded-mode-pattern'
                    });

                    result.hasChanges = true;
                }
            }

            // 设置 currentModels 为已选择的模型
            result.currentModels = selectedModels;

            // 降级模式下，无论是否找到变化，都应该直接返回结果
            // 因为我们无法获取渠道商的实际模型列表，继续比较是没有意义的
            // （selectedModels == currentModels 会导致所有模型都被认为"存在"）
            console.log(`📊 [DEBUG] 降级模式分析完成，发现 ${result.newMappings.length} 个需要修复的映射`);
            if (!result.hasChanges) {
                console.log(`⚠️ [DEBUG] 降级模式：无法获取渠道商实际模型，跳过此渠道`);
            }
            return result;
        }

        // 解析现有的模型映射
        let existingMapping = {};
        if (channel.model_mapping) {
            try {
                existingMapping = JSON.parse(channel.model_mapping);
                console.log(`🔧 [DEBUG] 现有映射数量: ${Object.keys(existingMapping).length}`);
                if (Object.keys(existingMapping).length > 0) {
                    console.log(`🔧 [DEBUG] 现有映射示例: ${Object.entries(existingMapping).slice(0, 3).map(([k,v]) => `${k}→${v}`).join(', ')}`);
                }
            } catch (e) {
                console.log(`⚠️ [DEBUG] 解析现有映射失败: ${e.message}`);
                existingMapping = {};
            }
        } else {
            console.log(`🔧 [DEBUG] 渠道无现有映射`);
        }

        const aliasToOriginal = new Map();
        if (Object.keys(existingMapping).length > 0) {
            for (const [aliasName, originalName] of Object.entries(existingMapping)) {
                const alias = String(aliasName || '').trim();
                const original = String(originalName || '').trim();
                if (!alias || !original) continue;
                aliasToOriginal.set(alias.toLowerCase(), original);
            }
        }

        // 分析每个已选择的模型
        console.log(`\n🔍 [DEBUG] 开始比较 ${selectedModels.length} 个已选择模型与 ${result.currentModels.length} 个实际模型...`);
        let comparisonCount = 0;
        let matchedCount = 0;
        let notInCurrentCount = 0;
        let hasValidMappingCount = 0;
        let needsFixCount = 0;
        let brokenMappingTargetCount = 0;

        const currentModelsLowerSet = new Set(
            result.currentModels.map(m => String(m).toLowerCase())
        );
        const minConfidenceThreshold = 60;
        const suggestedStandards = new Set();
        const candidateLimit = Number.isFinite(options.candidateLimit)
            ? Math.max(1, Math.min(20, Math.floor(options.candidateLimit)))
            : 8;
        const attachAliasSuggestion = (candidates, aliasName, originalName) => {
            if (!Array.isArray(candidates)) return candidates;
            const safeAlias = String(aliasName || '').trim();
            const safeOriginal = String(originalName || '').trim();
            if (!safeAlias || !safeOriginal) {
                return candidates.map((candidate) => {
                    if (typeof candidate === 'string') return { name: candidate };
                    if (candidate && typeof candidate === 'object') {
                        const name = candidate.name || candidate.match || candidate.value;
                        if (name) return { ...candidate, name: String(name) };
                    }
                    return candidate;
                });
            }
            return candidates.map((candidate) => {
                const name = typeof candidate === 'string'
                    ? candidate
                    : (candidate?.name || candidate?.match || candidate?.value || '');
                if (!name) return candidate;
                const suggestedAlias = buildAliasForActualChange(safeAlias, safeOriginal, name);
                if (typeof candidate === 'string') {
                    return suggestedAlias && suggestedAlias !== safeAlias
                        ? { name: String(name), alias: suggestedAlias }
                        : { name: String(name) };
                }
                if (candidate && typeof candidate === 'object') {
                    return suggestedAlias && suggestedAlias !== safeAlias
                        ? { ...candidate, name: String(name), alias: suggestedAlias }
                        : { ...candidate, name: String(name) };
                }
                return candidate;
            });
        };
        const buildRenameCandidates = (modelName, aliasName = '', originalName = '') => {
            let candidates = this.rankRenameCandidates(modelName, result.currentModels, options, candidateLimit);
            if (includeUpgrades) {
                const upgradeMatch = this.findBestUpgradeMatch(modelName, result.currentModels, options);
                if (upgradeMatch && upgradeMatch.match) {
                    const upgradeName = String(upgradeMatch.match);
                    const hasUpgrade = candidates.some((candidate) => {
                        const name = typeof candidate === 'string'
                            ? candidate
                            : (candidate?.name || candidate?.match || candidate?.value || '');
                        return String(name).toLowerCase() === upgradeName.toLowerCase();
                    });
                    if (!hasUpgrade) {
                        candidates = [{
                            name: upgradeName,
                            score: upgradeMatch.score,
                            method: upgradeMatch.method,
                            confidence: upgradeMatch.confidence
                        }, ...candidates];
                    }
                }
            }
            candidates = attachAliasSuggestion(candidates, aliasName, originalName);
            if (Array.isArray(candidates)) {
                return candidates.slice(0, candidateLimit);
            }
            return candidates;
        };
        const buildAllCandidates = (aliasName = '', originalName = '') => {
            const allCandidates = Array.isArray(result.currentModels)
                ? result.currentModels.map(name => ({ name }))
                : [];
            return attachAliasSuggestion(allCandidates, aliasName, originalName);
        };
        const isRuleMatch = (match) => {
            return Boolean(match && typeof match.method === 'string' && match.method.startsWith('rule-'));
        };
        const selectPreferredMatch = (renameMatch, upgradeMatch) => {
            if (!upgradeMatch) return { match: renameMatch, source: 'rename' };
            if (!renameMatch) return { match: upgradeMatch, source: 'upgrade' };

            const renameScore = typeof renameMatch.score === 'number' ? renameMatch.score : 0;
            const upgradeScore = typeof upgradeMatch.score === 'number' ? upgradeMatch.score : 0;
            const renameOk = renameScore >= minConfidenceThreshold;
            const upgradeOk = upgradeScore >= minConfidenceThreshold;

            if (renameOk && !upgradeOk) return { match: renameMatch, source: 'rename' };
            if (upgradeOk && !renameOk) return { match: upgradeMatch, source: 'upgrade' };
            if (isRuleMatch(renameMatch) && renameOk) return { match: renameMatch, source: 'rename' };

            const renameInfo = this.parseModelVersionInfo(renameMatch.match);
            const upgradeInfo = this.parseModelVersionInfo(upgradeMatch.match);
            if (renameInfo && upgradeInfo) {
                const compare = this.compareVersionParts(upgradeInfo.versionParts, renameInfo.versionParts);
                if (compare > 0) return { match: upgradeMatch, source: 'upgrade' };
                if (compare < 0) return { match: renameMatch, source: 'rename' };
            }

            if (upgradeScore >= renameScore) {
                return { match: upgradeMatch, source: 'upgrade' };
            }
            return { match: renameMatch, source: 'rename' };
        };

        // 首先检查现有映射的目标是否在上游存在
        // 这是核心修复：映射目标必须在上游模型列表中
        console.log(`\n🔍 [DEBUG] 检查现有映射目标是否在上游存在...`);
        for (const [aliasName, originalName] of Object.entries(existingMapping)) {
            const originalLower = String(originalName).toLowerCase();
            const originalExists = currentModelsLowerSet.has(originalLower);

            if (!originalExists) {
                brokenMappingTargetCount++;
                console.log(`  ❌ [DEBUG] 映射目标不存在! "${aliasName}" → "${originalName}" (上游无此模型)`);

                // 尝试为这个失效的映射找到新的目标
                const renameMatch = this.findBestMatchForRenamedModel(originalName, result.currentModels, {}, options);
                const upgradeMatch = includeUpgrades
                    ? this.findBestUpgradeMatch(originalName, result.currentModels, options)
                    : null;
                const preferred = selectPreferredMatch(renameMatch, upgradeMatch);
                const bestMatch = preferred.match;
                const candidates = buildRenameCandidates(originalName, aliasName, originalName);
                const brokenReason = preferred.source === 'upgrade'
                    ? '映射目标在上游不存在（已升级版本）'
                    : '映射目标在上游不存在';

                result.brokenMappings.push({
                    originalModel: aliasName,
                    expectedModel: originalName,
                    reason: brokenReason
                });

                if (bestMatch && bestMatch.score >= minConfidenceThreshold) {
                    const updatedAlias = buildAliasForActualChange(aliasName, originalName, bestMatch.match);
                    const aliasChanged = updatedAlias && updatedAlias !== aliasName;

                    if (aliasChanged) {
                        console.log(`  🎯 [DEBUG] 找到替代目标! "${originalName}" → "${bestMatch.match}"，别名升级为 "${updatedAlias}"`);
                        result.newMappings.push({
                            standardName: updatedAlias,
                            actualName: bestMatch.match,
                            originalModel: aliasName,
                            sourceStandard: aliasName,
                            confidence: bestMatch.score,
                            method: bestMatch.method,
                            fixType: 'mapping-upgrade',
                            displayTarget: updatedAlias,
                            candidates
                        });
                    } else {
                        console.log(`  🎯 [DEBUG] 找到替代目标! "${originalName}" → "${bestMatch.match}" (${bestMatch.method}, 分数: ${bestMatch.score})`);
                        result.newMappings.push({
                            standardName: aliasName,
                            actualName: bestMatch.match,
                            originalModel: aliasName,
                            confidence: bestMatch.score,
                            method: bestMatch.method,
                            fixType: 'broken-mapping-target',
                            candidates
                        });
                    }
                    suggestedStandards.add(String(aliasName).toLowerCase());
                    result.hasChanges = true;
                } else {
                    console.log(`  ⚠️ [DEBUG] 未找到替代目标，建议删除此映射: "${aliasName}" → "${originalName}"`);

                    // 即使没找到替代，也标记为需要修复（删除无效映射）
                    const candidateText = bestMatch && bestMatch.match ? String(bestMatch.match).trim() : '';
                    const displayTarget = candidateText ? `建议删除（候选: ${candidateText}）` : '建议删除';
                    const confidence = bestMatch && typeof bestMatch.score === 'number' ? bestMatch.score : 0;
                    const method = bestMatch && bestMatch.method ? bestMatch.method : 'remove-broken-mapping';
                    result.newMappings.push({
                        standardName: aliasName,
                        actualName: null,  // null 表示应该删除此映射
                        originalModel: aliasName,
                        confidence,
                        method,
                        fixType: 'remove-invalid',
                        action: 'delete',
                        removeModel: true,
                        displayTarget,
                        candidates: buildAllCandidates(aliasName, originalName)
                    });
                    suggestedStandards.add(String(aliasName).toLowerCase());
                    result.hasChanges = true;
                }
            } else if (includeUpgrades) {
                const upgrade = findBestMappingUpgrade(aliasName, originalName, result.currentModels);
                if (upgrade && upgrade.newActual && upgrade.newAlias &&
                    (upgrade.newAlias !== aliasName || upgrade.newActual !== originalName)) {
                    const aliasChanged = upgrade.newAlias !== aliasName;
                    console.log(`  📈 [DEBUG] 映射升级: "${originalName}" → "${upgrade.newActual}" (别名: "${aliasName}" → "${upgrade.newAlias}")`);
                    result.newMappings.push({
                        standardName: upgrade.newAlias,
                        actualName: upgrade.newActual,
                        originalModel: aliasName,
                        sourceStandard: aliasName,
                        confidence: upgrade.score,
                        method: upgrade.method,
                        fixType: 'mapping-upgrade',
                        ...(aliasChanged ? { displayTarget: upgrade.newAlias } : {})
                    });
                    suggestedStandards.add(String(aliasName).toLowerCase());
                    result.hasChanges = true;
                }
            }
        }

        console.log(`📊 [DEBUG] 映射目标检查完成: ${brokenMappingTargetCount} 个映射目标在上游不存在`);

        // 检查没有映射的模型是否在上游存在
        // 关键逻辑：
        // - 如果模型有映射 A → B，只需检查 B（已在上面完成）
        // - 如果模型没有映射，需要检查模型本身是否在上游存在
        for (const selectedModel of selectedModels) {
            comparisonCount++;

            const selectedLower = selectedModel.toLowerCase();
            const mappedOriginal = aliasToOriginal.get(selectedLower);

            // 如果有映射，映射目标的检查已在上面完成，跳过
            if (mappedOriginal) {
                const targetExists = currentModelsLowerSet.has(String(mappedOriginal).toLowerCase());
                if (targetExists) {
                    hasValidMappingCount++;
                    if (comparisonCount <= 5) {
                        console.log(`  ✅ [DEBUG] "${selectedModel}" → "${mappedOriginal}" 映射有效`);
                    }
                }
                // 无论映射是否有效，都已在上面处理过，跳过
                continue;
            }

            // 没有映射：检查模型本身是否在上游存在
            const isInCurrentModels = currentModelsLowerSet.has(selectedLower);

            if (isInCurrentModels) {
                matchedCount++;
                // 只在前几个模型时输出详细日志
                if (comparisonCount <= 5) {
                    console.log(`  ✅ [DEBUG] "${selectedModel}" - 在实际模型中存在（无映射，直接调用）`);
                }

                // 检查版本升级（可选功能）
                if (includeUpgrades && !suggestedStandards.has(selectedLower)) {
                    console.log(`  🔍 [DEBUG] 检查版本升级: "${selectedModel}" (includeUpgrades=${includeUpgrades})`);
                    const upgradeMatch = this.findBestUpgradeMatch(selectedModel, result.currentModels, options);
                    if (upgradeMatch && upgradeMatch.match && upgradeMatch.score >= minConfidenceThreshold &&
                        String(upgradeMatch.match).toLowerCase() !== selectedLower) {
                        needsFixCount++;
                        console.log(`  [DEBUG] 发现升级候选! "${selectedModel}" → "${upgradeMatch.match}" (${upgradeMatch.method}, 分数: ${upgradeMatch.score})`);

                        const updatedStandard = this.stripModelPrefix(upgradeMatch.match) || upgradeMatch.match;
                        result.newMappings.push({
                            standardName: updatedStandard,
                            actualName: upgradeMatch.match,
                            originalModel: selectedModel,
                            confidence: upgradeMatch.score,
                            method: upgradeMatch.method
                        });
                        suggestedStandards.add(selectedLower);

                        result.hasChanges = true;
                    }
                }
            } else {
                notInCurrentCount++;
                console.log(`  ❌ [DEBUG] "${selectedModel}" - 不在实际模型中且无映射!`);

                // 模型不在当前可用列表中且没有映射，可能是渠道商改名了
                // 尝试智能匹配找到新名称
                console.log(`  🔍 [DEBUG] 为 "${selectedModel}" 寻找智能匹配...`);

                // 优先使用用户规则匹配
                const hasUserRules = this.userRules.nameMatch.length > 0 ||
                                    this.userRules.custom.length > 0;

                const renameMatch = hasUserRules
                    ? this.findMatchWithUserRules(selectedModel, result.currentModels, existingMapping, options)
                    : this.findBestMatchForRenamedModel(selectedModel, result.currentModels, existingMapping, options);
                const upgradeMatch = includeUpgrades
                    ? this.findBestUpgradeMatch(selectedModel, result.currentModels, options)
                    : null;
                const preferred = selectPreferredMatch(renameMatch, upgradeMatch);
                const bestMatch = preferred.match;
                const matchReason = preferred.source === 'upgrade'
                    ? '模型版本升级'
                    : '模型在上游不存在（可能已改名）';

                if (bestMatch) {
                    // 增加最低置信度门槛：低于60%的匹配不自动添加
                    if (bestMatch.score < minConfidenceThreshold) {
                        console.log(`  ⚠️ [DEBUG] "${selectedModel}" 匹配 "${bestMatch.match}" 置信度过低 (${bestMatch.score}% < ${minConfidenceThreshold}%)，跳过`);
                        const candidateText = bestMatch && bestMatch.match ? String(bestMatch.match).trim() : '';
                        const displayTarget = candidateText ? `\u5efa\u8bae\u5220\u9664(\u5019\u9009: ${candidateText})` : '\u5efa\u8bae\u5220\u9664';
                        result.brokenMappings.push({
                            originalModel: selectedModel,
                            expectedModel: selectedModel,
                            reason: '\u6a21\u578b\u5728\u4e0a\u6e38\u4e0d\u5b58\u5728(\u4f4e\u7f6e\u4fe1\u5339\u914d,\u5efa\u8bae\u5220\u9664)'
                        });
                        result.newMappings.push({
                            standardName: selectedModel,
                            actualName: null,
                            originalModel: selectedModel,
                            confidence: bestMatch.score,
                            method: bestMatch.method,
                            fixType: 'remove-invalid',
                            action: 'delete',
                            removeModel: true,
                            displayTarget,
                            candidates: buildAllCandidates(selectedModel, selectedModel)
                        });
                        suggestedStandards.add(selectedLower);
                        result.hasChanges = true;
                        needsFixCount++;
                        continue;
                    }

                    // 如果匹配结果和原始模型相同，跳过（无意义的匹配）
                    if (String(bestMatch.match).toLowerCase() === selectedLower) {
                        console.log(`  ⚠️ [DEBUG] "${selectedModel}" 匹配结果与原模型相同，跳过`);
                        continue;
                    }

                    needsFixCount++;
                    console.log(`  🎯 [DEBUG] 找到匹配! "${selectedModel}" → "${bestMatch.match}" (${bestMatch.method}, 分数: ${bestMatch.score})`);

                    result.brokenMappings.push({
                        originalModel: selectedModel,
                        expectedModel: selectedModel,
                        reason: matchReason
                    });

                    const updatedStandard = this.stripModelPrefix(bestMatch.match) || bestMatch.match;
                    result.newMappings.push({
                        standardName: updatedStandard,
                        actualName: bestMatch.match,
                        originalModel: selectedModel,
                        confidence: bestMatch.score,
                        method: bestMatch.method,
                        candidates: buildRenameCandidates(selectedModel, selectedModel, selectedModel)
                    });
                    suggestedStandards.add(selectedLower);

                    result.hasChanges = true;
                } else {
                    console.log(`  ⚠️ [DEBUG] "${selectedModel}" 未找到匹配`);
                    const displayTarget = '\u5efa\u8bae\u5220\u9664';
                    result.brokenMappings.push({
                        originalModel: selectedModel,
                        expectedModel: selectedModel,
                        reason: '\u6a21\u578b\u5728\u4e0a\u6e38\u4e0d\u5b58\u5728\u4e14\u672a\u627e\u5230\u5339\u914d,\u5efa\u8bae\u5220\u9664'
                    });
                    result.newMappings.push({
                        standardName: selectedModel,
                        actualName: null,
                        originalModel: selectedModel,
                        confidence: 0,
                        method: 'remove-invalid',
                        fixType: 'remove-invalid',
                        action: 'delete',
                        removeModel: true,
                        displayTarget,
                        candidates: buildAllCandidates(selectedModel, selectedModel)
                    });
                    suggestedStandards.add(selectedLower);
                    result.hasChanges = true;
                    needsFixCount++;
                }
            }
        }

        console.log(`\n📊 [DEBUG] 渠道 ${channel.id} 分析完成:`);
        console.log(`   - 已选择模型总数: ${selectedModels.length}`);
        console.log(`   - 在实际模型中存在: ${matchedCount}`);
        console.log(`   - 不在实际模型中: ${notInCurrentCount}`);
        console.log(`   - 已有有效映射: ${hasValidMappingCount}`);
        console.log(`   - 需要修复: ${needsFixCount}`);
        console.log(`   - hasChanges: ${result.hasChanges}`);
        console.log(`   - brokenMappings: ${result.brokenMappings.length}`);
        console.log(`   - newMappings: ${result.newMappings.length}`);

        return result;
    }

    /**
     * 为改名的模型寻找最佳匹配
     * 特别处理渠道商的命名前缀/后缀，如 "[反重力]claude-opus-4"
     *
     * @param {string} originalModel - 原始模型名
     * @param {Array} currentModels - 当前可用模型列表
     * @param {Object} existingMapping - 现有映射
     * @returns {Object|null} 匹配结果
     */
    findBestMatchForRenamedModel(originalModel, currentModels, existingMapping = {}, options = {}) {
        if (!originalModel || !currentModels || currentModels.length === 0) {
            return null;
        }

        const debug = Boolean((options && options.debug) ?? this.config?.debug);
        const console = debug ? globalThis.console : { log: () => {}, warn: () => {}, error: () => {} };

        const originalLower = originalModel.toLowerCase();

        // 提取模型核心名称（去除版本号等）
        const coreModelName = this.extractCoreModelName(originalModel);
        const coreLower = coreModelName.toLowerCase();

        // 提取源模型的系列信息（用于防止跨系列误判）
        const sourceFamily = this.extractModelFamily(originalModel);

        // 提取源模型的功能后缀（用于防止跨功能误匹配）
        const sourceFuncSuffix = this.extractFunctionalSuffix(originalModel);

        // 1) 精确匹配（不区分大小写）- 置信度 100
        const exact = currentModels.find(m => String(m).toLowerCase() === originalLower);
        if (exact) {
            return { match: exact, score: 100, method: 'exact', confidence: 'high' };
        }

        // 2) 快速扫描：前缀/后缀/核心匹配（严格模式）
        let best = null;
        for (const currentModel of currentModels) {
            if (!currentModel || typeof currentModel !== 'string') continue;

            const currentLower = currentModel.toLowerCase();

            // 系列校验：防止跨系列误判
            const targetFamily = this.extractModelFamily(currentModel);
            if (!this.isSameModelFamily(sourceFamily, targetFamily)) {
                continue; // 跳过不同系列的模型
            }

            // 功能后缀校验：防止跨功能误匹配（如 pro 不应匹配 pro-image）
            const targetFuncSuffix = this.extractFunctionalSuffix(currentModel);
            if (sourceFuncSuffix !== targetFuncSuffix) {
                continue; // 跳过功能后缀不匹配的模型
            }

            let score = 0;
            let method = '';
            let confidence = 'low';

            // 渠道商前缀匹配（如 [反重力]claude-opus-4 -> claude-opus-4）
            if (this.isProviderPrefixedModel(currentModel, originalModel)) {
                score = 95;
                method = 'provider-prefix';
                confidence = 'high';
            }
            // 渠道商后缀匹配（如 claude-opus-4-硅基流动 -> claude-opus-4）
            else if (this.isProviderSuffixedModel(currentModel, originalModel)) {
                score = 93;
                method = 'provider-suffix';
                confidence = 'high';
            }
            // 核心名称匹配（严格模式：要求高相似度）
            else if (coreLower && currentLower.includes(coreLower)) {
                const ratio = coreLower.length / currentLower.length;
                // 只有当核心名称占比超过 60% 时才认为是有效匹配
                if (ratio >= 0.6) {
                    score = Math.round(75 + ratio * 20);
                    method = 'core-match';
                    confidence = ratio >= 0.8 ? 'high' : 'medium';
                } else {
                    continue; // 相似度太低，跳过
                }
            }
            // 反向核心匹配（当前模型名包含在原始模型中）
            else if (coreLower && coreLower.includes(currentLower)) {
                const ratio = currentLower.length / coreLower.length;
                if (ratio >= 0.6) {
                    score = Math.round(70 + ratio * 15);
                    method = 'reverse-core-match';
                    confidence = ratio >= 0.8 ? 'medium' : 'low';
                } else {
                    continue;
                }
            } else {
                continue;
            }

            if (!best || score > best.score) {
                best = { match: currentModel, score, method, confidence };
                if (score >= 95) break; // 高置信度匹配，提前退出
            }
        }

        if (best && best.score >= 70) {
            console.log(`🔍 为 "${originalModel}" 找到最佳匹配: "${best.match}" (${best.method}, 分数: ${best.score}, 置信度: ${best.confidence})`);
            return best;
        }

        // 3) 最后备选：通用匹配算法（严格模式）
        // 只在同系列模型中搜索
        const sameFamilyCandidates = currentModels.filter(m => {
            const targetFamily = this.extractModelFamily(m);
            return this.isSameModelFamily(sourceFamily, targetFamily);
        });

        if (sameFamilyCandidates.length === 0) {
            console.log(`⚠️ 为 "${originalModel}" 未找到同系列候选模型`);
            return null;
        }

        // 进一步过滤：只保留包含核心名称的候选
        const filteredCandidates = coreLower
            ? sameFamilyCandidates.filter(m => {
                const lower = String(m).toLowerCase();
                return lower.includes(coreLower) || coreLower.includes(lower);
            })
            : sameFamilyCandidates;

        if (filteredCandidates.length === 0) {
            console.log(`⚠️ 为 "${originalModel}" 未找到包含核心名称的候选模型`);
            return null;
        }

        const smart = this.findBestMatch(originalModel, filteredCandidates, options);
        if (!smart) return null;

        const smartLower = String(smart).toLowerCase();
        const similarity = this.calculateSimilarity(originalLower, smartLower);
        // 严格模式：相似度必须超过 50%
        if (similarity < 0.5) {
            console.log(`⚠️ 为 "${originalModel}" 找到的匹配 "${smart}" 相似度过低 (${Math.round(similarity * 100)}%)`);
            return null;
        }

        const score = Math.round(60 + similarity * 30);
        const confidence = similarity >= 0.8 ? 'medium' : 'low';
        const result = { match: smart, score, method: 'smart-match', confidence };
        console.log(`🔍 为 "${originalModel}" 找到最佳匹配: "${result.match}" (${result.method}, 分数: ${result.score}, 置信度: ${result.confidence})`);
        return result;
    }

    /**
     * 获取改名匹配候选列表（用于下拉选择）
     */
    rankRenameCandidates(originalModel, currentModels, options = {}, limit = 8) {
        if (!originalModel || !Array.isArray(currentModels) || currentModels.length === 0) {
            return [];
        }

        const originalLower = String(originalModel).toLowerCase();
        const coreModelName = this.extractCoreModelName(originalModel);
        const coreLower = coreModelName ? coreModelName.toLowerCase() : '';
        const sourceFamily = this.extractModelFamily(originalModel);
        const sourceFuncSuffix = this.extractFunctionalSuffix(originalModel);

        const candidateMap = new Map();
        const addCandidate = (name, score, method, confidence) => {
            if (!name || !Number.isFinite(score)) return;
            const key = String(name).toLowerCase();
            const existing = candidateMap.get(key);
            if (!existing || score > existing.score) {
                candidateMap.set(key, {
                    name: String(name),
                    score,
                    method: method || 'match',
                    confidence: confidence || 'low'
                });
            }
        };

        for (const currentModel of currentModels) {
            if (!currentModel || typeof currentModel !== 'string') continue;
            const currentLower = currentModel.toLowerCase();

            if (currentLower === originalLower) {
                addCandidate(currentModel, 100, 'exact', 'high');
                continue;
            }

            const targetFamily = this.extractModelFamily(currentModel);
            if (!this.isSameModelFamily(sourceFamily, targetFamily)) {
                continue;
            }

            const targetFuncSuffix = this.extractFunctionalSuffix(currentModel);
            if (sourceFuncSuffix !== targetFuncSuffix) {
                continue;
            }

            let score = 0;
            let method = '';
            let confidence = 'low';

            if (this.isProviderPrefixedModel(currentModel, originalModel)) {
                score = 95;
                method = 'provider-prefix';
                confidence = 'high';
            } else if (this.isProviderSuffixedModel(currentModel, originalModel)) {
                score = 93;
                method = 'provider-suffix';
                confidence = 'high';
            } else if (coreLower && currentLower.includes(coreLower)) {
                const ratio = coreLower.length / currentLower.length;
                if (ratio >= 0.6) {
                    score = Math.round(75 + ratio * 20);
                    method = 'core-match';
                    confidence = ratio >= 0.8 ? 'high' : 'medium';
                }
            } else if (coreLower && coreLower.includes(currentLower)) {
                const ratio = currentLower.length / coreLower.length;
                if (ratio >= 0.6) {
                    score = Math.round(70 + ratio * 15);
                    method = 'reverse-core-match';
                    confidence = ratio >= 0.8 ? 'medium' : 'low';
                }
            }

            if (score > 0) {
                addCandidate(currentModel, score, method, confidence);
            }
        }

        const sameFamilyCandidates = currentModels.filter(m => {
            if (!m || typeof m !== 'string') return false;
            const targetFamily = this.extractModelFamily(m);
            if (!this.isSameModelFamily(sourceFamily, targetFamily)) return false;
            const targetFuncSuffix = this.extractFunctionalSuffix(m);
            return sourceFuncSuffix === targetFuncSuffix;
        });

        const fallbackCandidates = coreLower
            ? sameFamilyCandidates.filter(m => {
                const lower = String(m).toLowerCase();
                return lower.includes(coreLower) || coreLower.includes(lower);
            })
            : sameFamilyCandidates;

        for (const candidate of fallbackCandidates) {
            const similarity = this.calculateSimilarity(originalLower, String(candidate).toLowerCase());
            if (similarity < 0.5) continue;
            const score = Math.round(60 + similarity * 30);
            const confidence = similarity >= 0.8 ? 'medium' : 'low';
            addCandidate(candidate, score, 'smart-match', confidence);
        }

        const result = Array.from(candidateMap.values())
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

        if (!Number.isFinite(limit) || limit <= 0) {
            return result;
        }
        return result.slice(0, limit);
    }


    /**
     * 查找同系列的版本升级模型（如 gemini-2.5 -> gemini-3）
     */
    findBestUpgradeMatch(originalModel, currentModels, options = {}) {
        if (!originalModel || !currentModels || currentModels.length === 0) {
            return null;
        }

        const debug = Boolean((options && options.debug) ?? this.config?.debug);
        const console = debug ? globalThis.console : { log: () => {}, warn: () => {}, error: () => {} };

        const sourceInfo = this.parseModelVersionInfo(originalModel);
        if (!sourceInfo) {
            return null;
        }

        // 提取源模型的功能后缀（如 image, vision, audio 等）
        const sourceFuncSuffix = this.extractFunctionalSuffix(originalModel);

        const sourceFamily = this.extractModelFamily(originalModel);
        let best = null;

        for (const currentModel of currentModels) {
            if (!currentModel || typeof currentModel !== 'string') continue;

            const targetInfo = this.parseModelVersionInfo(currentModel);
            if (!targetInfo) continue;

            if (targetInfo.base !== sourceInfo.base) continue;
            if (!this.isVariantCompatible(sourceInfo.variant, targetInfo.variant)) continue;

            // 检查功能后缀是否匹配（如 image, vision 等）
            const targetFuncSuffix = this.extractFunctionalSuffix(currentModel);
            if (sourceFuncSuffix !== targetFuncSuffix) continue;

            // 注意：版本升级场景不检查 isSameModelFamily，因为已经通过 base 和 variant 验证了兼容性

            const versionCompare = this.compareVersionParts(targetInfo.versionParts, sourceInfo.versionParts);
            if (versionCompare <= 0) continue;

            let score = 85;
            const majorSource = sourceInfo.versionParts[0] || 0;
            const majorTarget = targetInfo.versionParts[0] || 0;
            if (majorTarget > majorSource) {
                score = 90;
            }
            if (sourceInfo.variant && targetInfo.variant === sourceInfo.variant) {
                score += 3;
            }
            score = Math.min(score, 95);

            if (!best ||
                this.compareVersionParts(targetInfo.versionParts, best.versionParts) > 0 ||
                (this.compareVersionParts(targetInfo.versionParts, best.versionParts) === 0 && score > best.score)) {
                best = {
                    match: currentModel,
                    score,
                    method: 'version-upgrade',
                    confidence: score >= 90 ? 'high' : 'medium',
                    versionParts: targetInfo.versionParts
                };
            }
        }

        if (best) {
            console.log(`为 "${originalModel}" 找到升级候选: "${best.match}" (分数: ${best.score})`);
            return { match: best.match, score: best.score, method: best.method, confidence: best.confidence };
        }

        return null;
    }

    /**
     * 检查是否是渠道商加前缀的模型名
     * 例如: "[反重力]claude-opus-4" 对应 "claude-opus-4"
     */
    isProviderPrefixedModel(currentModel, originalModel) {
        // 常见的渠道商前缀模式
        const prefixPatterns = [
            /^\[.+?\]/,           // [xxx]model
            /^【.+?】/,           // 【xxx】model
            /^\(.+?\)/,           // (xxx)model
            /^（.+?）/,           // （xxx）model
            /^<.+?>/,             // <xxx>model
            /^「.+?」/,           // 「xxx」model
            /^『.+?』/,           // 『xxx』model
            /^@[A-Za-z0-9_-]+\//,  // @provider/model
        ];

        // 首先检查currentModel是否有可识别的前缀
        let strippedModel = currentModel;
        let foundPrefix = false;

        // 循环去除所有前缀
        let hasPrefix = true;
        while (hasPrefix) {
            hasPrefix = false;
            for (const pattern of prefixPatterns) {
                if (pattern.test(strippedModel)) {
                    strippedModel = strippedModel.replace(pattern, '');
                    hasPrefix = true;
                    foundPrefix = true;
                    break;
                }
            }
        }

        // 只有当发现了前缀，并且去除前缀后精确匹配时才返回true
        if (foundPrefix && strippedModel.toLowerCase() === originalModel.toLowerCase()) {
            return true;
        }

        return false;
    }

    /**
     * 检查是否是渠道商加后缀的模型名
     * 例如: "claude-opus-4-硅基流动" 对应 "claude-opus-4"
     */
    isProviderSuffixedModel(currentModel, originalModel) {
        // 常见的渠道商后缀模式
        const suffixPatterns = [
            /-[\u4e00-\u9fa5]+$/,   // -中文
            /_[\u4e00-\u9fa5]+$/,   // _中文
            /@[\u4e00-\u9fa5]+$/,   // @中文
            /#[\u4e00-\u9fa5]+$/,   // #中文
            /-[A-Za-z]+$/,          // -provider
            /_[A-Za-z]+$/,          // _provider
            /@[A-Za-z]+$/,          // @provider
            /\/[A-Za-z0-9_-]+$/,    // /provider
            /\[[^\]]+\]$/,          // model[xxx]
            /【[^】]+】$/,          // model【xxx】
            /\([^)]+\)$/,           // model(xxx)
            /（[^）]+）$/,          // model（xxx）
            /-v\d+(\.\d+)*$/i,      // -v1.0.0 (版本号后缀)
            /_v\d+(\.\d+)*$/i,      // _v1.0.0
            /-\d{8,}$/,             // -20240101 (日期后缀)
            /_\d{8,}$/,             // _20240101
        ];

        for (const pattern of suffixPatterns) {
            const stripped = currentModel.replace(pattern, '');
            if (stripped.toLowerCase() === originalModel.toLowerCase()) {
                return true;
            }
            // 也检查去除后缀后是否包含原始模型名
            if (stripped.toLowerCase() === originalModel.toLowerCase() ||
                stripped.toLowerCase().endsWith(originalModel.toLowerCase())) {
                return true;
            }
        }

        // 检查原始模型是否是当前模型的前缀
        if (currentModel.toLowerCase().startsWith(originalModel.toLowerCase())) {
            const suffix = currentModel.slice(originalModel.length);
            // 后缀应该以分隔符开始
            if (suffix.match(/^[-_@#\/\[\(【（]/)) {
                return true;
            }
        }

        // 检查是否有多个后缀的情况，如 "model-suffix1-suffix2"
        let strippedModel = currentModel;
        let hasSuffix = true;
        while (hasSuffix) {
            hasSuffix = false;
            for (const pattern of suffixPatterns) {
                if (pattern.test(strippedModel)) {
                    strippedModel = strippedModel.replace(pattern, '');
                    hasSuffix = true;
                    break;
                }
            }
        }
        if (strippedModel.toLowerCase() === originalModel.toLowerCase()) {
            return true;
        }

        return false;
    }

    /**
     * 提取模型的核心名称（去除版本号、变体等）
     */
    extractCoreModelName(modelName) {
        let core = modelName;

        // 第一步：移除前缀标记（必须先做，否则后面的版本号移除会出错）
        core = core
            .replace(/^\[.+?\]/, '')  // 移除 [xxx] 前缀
            .replace(/^【.+?】/, '')  // 移除 【xxx】 前缀
            .replace(/^\(.+?\)/, '')  // 移除 (xxx) 前缀
            .replace(/^（.+?）/, '')  // 移除 （xxx） 前缀
            .replace(/^@[A-Za-z0-9_-]+\//, '');  // 移除 @provider/ 前缀

        // 第二步：移除版本号后缀（只匹配明确的版本格式，如 -v1.0.0 或 -v2）
        // 注意：不要匹配单个数字如 -4，因为这可能是模型名称的一部分（如 gpt-4）
        core = core
            .replace(/[-_]v\d+(\.\d+)*$/i, '')  // 移除 -v1.0.0 格式
            .replace(/[-_]\d+\.\d+(\.\d+)*$/i, '');  // 移除 -1.0.0 格式（必须有小数点）

        // 第三步：移除日期格式后缀（8位以上数字）
        core = core.replace(/[-_]\d{8,}$/i, '');

        // 第四步：移除常见变体后缀
        core = core.replace(/[-_](mini|nano|lite|small|large|xl|xxl|turbo|plus)$/i, '');

        // 第五步：移除中文后缀（如 -硅基流动, -官方, _测试 等）
        core = core.replace(/[-_@#][\u4e00-\u9fa5]+$/, '');  // 移除 -中文 后缀

        // 第六步：移除英文提供商后缀（如 -official, -test 等）
        core = core.replace(/[-_](official|test|beta|alpha|preview|dev|prod|stable)$/i, '');

        return core.trim() || modelName;
    }

    /**
     * 移除模型名前缀（保留主体，便于版本解析）
     */
    stripModelPrefix(modelName) {
        if (!modelName) return '';
        return String(modelName)
            .trim()
            .replace(/^\[.+?\]/, '')
            .replace(/^【.+?】/, '')
            .replace(/^\(.+?\)/, '')
            .replace(/^（.+?）/, '')
            .replace(/^@[A-Za-z0-9_-]+\//, '')
            .trim();
    }

    /**
     * 提取模型的功能后缀（如 image, vision, audio 等）
     * 用于防止跨功能误匹配，如 gemini-3-pro-preview 不应匹配 gemini-3-pro-image-preview
     */
    extractFunctionalSuffix(modelName) {
        if (!modelName) return '';
        const lower = modelName.toLowerCase();

        // 功能后缀列表（按优先级排序）
        const functionalSuffixes = [
            'image', 'vision', 'audio', 'video', 'multimodal',
            'code', 'coder', 'instruct', 'chat', 'embedding',
            'search', 'thinking', 'reasoning'
        ];

        for (const suffix of functionalSuffixes) {
            // 检查是否包含该功能后缀（作为独立词）
            const pattern = new RegExp(`[-_]${suffix}[-_]|[-_]${suffix}$`, 'i');
            if (pattern.test(lower)) {
                return suffix;
            }
        }

        return '';
    }

    /**
     * 解析模型版本信息（用于升级检测）
     */
    parseModelVersionInfo(modelName) {
        if (!modelName) return null;

        const normalized = this.stripModelPrefix(modelName);
        if (!normalized) return null;

        const match = normalized.match(/^(.*?)(\d+(?:\.\d+)*)(.*)$/);
        if (!match) return null;

        const base = match[1].replace(/[-_./]+$/g, '').toLowerCase();
        const versionText = match[2];
        const suffix = (match[3] || '').replace(/^[-_./]+/, '').toLowerCase();

        if (!base) return null;

        const versionParts = versionText.split('.').map(part => Number(part));
        if (versionParts.some(part => Number.isNaN(part))) return null;

        const variant = this.extractVariantToken(suffix);

        return {
            base,
            versionParts,
            variant,
            suffix
        };
    }

    /**
     * 提取变体标识
     */
    extractVariantToken(suffix) {
        if (!suffix) return '';
        const tokens = suffix.split(/[-_/]/).filter(Boolean);
        if (tokens.length === 0) return '';

        const preferredTokens = ['mini', 'nano', 'lite', 'small', 'turbo', 'pro', 'flash', 'opus', 'sonnet', 'haiku'];
        for (const token of tokens) {
            if (preferredTokens.includes(token)) {
                return token;
            }
        }

        const first = tokens[0];
        if (/^v?\d+(\.\d+)*$/.test(first)) {
            return '';
        }
        return first;
    }

    /**
     * 判断变体是否兼容
     */
    isVariantCompatible(sourceVariant, targetVariant) {
        if (!sourceVariant) {
            return !targetVariant;
        }
        return sourceVariant === targetVariant;
    }

    /**
     * 比较版本号数组
     */
    compareVersionParts(a = [], b = []) {
        const maxLen = Math.max(a.length, b.length);
        for (let i = 0; i < maxLen; i++) {
            const left = Number(a[i] ?? 0);
            const right = Number(b[i] ?? 0);
            if (left > right) return 1;
            if (left < right) return -1;
        }
        return 0;
    }

    /**
     * 计算两个字符串的相似度（简化版）
     */
    calculateSimilarity(str1, str2) {
        const s1 = str1.toLowerCase();
        const s2 = str2.toLowerCase();

        if (s1 === s2) return 1;
        if (s1.length === 0 || s2.length === 0) return 0;

        // 使用Jaccard相似度
        const set1 = new Set(s1.split(''));
        const set2 = new Set(s2.split(''));
        const intersection = new Set([...set1].filter(x => set2.has(x)));
        const union = new Set([...set1, ...set2]);

        return intersection.size / union.size;
    }

    /**
     * 解析模型列表字符串（支持逗号/换行/中文分隔符）
     */
    parseModelList(modelsRaw) {
        if (!modelsRaw) return [];
        if (Array.isArray(modelsRaw)) {
            return modelsRaw.map(m => String(m).trim()).filter(Boolean);
        }
        return String(modelsRaw)
            .split(/[\n\r,，;；]+/)
            .map(m => m.trim())
            .filter(Boolean);
    }

    /**
     * 应用模型更新（覆盖或追加旧模型）
     */
    async applyModelMappingFix(channel, analysisResult, options = {}) {
        try {
            const debug = Boolean((options && options.debug) ?? this.config?.debug);
            const updateMode = options.updateMode === 'append' ? 'append' : 'replace';
            const shouldUpdateMapping = options.updateMapping !== false;
            let existingMapping = {};
            let mappingParsed = false;
            const hasExistingMapping = channel && channel.model_mapping != null && String(channel.model_mapping).trim() !== '';

            if (shouldUpdateMapping && hasExistingMapping) {
                if (typeof channel.model_mapping === 'object') {
                    existingMapping = channel.model_mapping || {};
                    mappingParsed = true;
                } else {
                    try {
                        existingMapping = JSON.parse(channel.model_mapping);
                        mappingParsed = true;
                    } catch (e) {
                        existingMapping = {};
                    }
                }
            }

            const mappingReplacements = new Map();
            const modelReplacements = new Map();
            const mappingRemovals = new Set();  // 需要删除的映射键
            const mappingAdditions = new Map();
            const modelRemovals = new Set();

            const addMappingReplacement = (oldName, newName) => {
                if (!oldName) return;
                const key = String(oldName).trim();
                if (!key) return;

                // newName 为 null 表示需要删除此映射
                if (newName === null) {
                    mappingRemovals.add(key.toLowerCase());
                    return;
                }

                const value = String(newName).trim();
                if (!value) return;
                mappingReplacements.set(key.toLowerCase(), { oldName: key, newName: value });
            };

            const addMappingAddition = (standardName, newName) => {
                if (!standardName || !newName) return;
                const key = String(standardName).trim();
                const value = String(newName).trim();
                if (!key || !value) return;
                mappingAdditions.set(key.toLowerCase(), { standardName: key, newActual: value });
            };

            const addModelReplacement = (oldName, newName) => {
                if (!oldName) return;
                const key = String(oldName).trim();
                if (!key) return;
                const value = String(newName ?? '').trim();
                if (!value) return;
                modelReplacements.set(key.toLowerCase(), { oldName: key, newName: value });
            };
            const addModelRemoval = (name) => {
                if (!name) return;
                const key = String(name).trim();
                if (!key) return;
                modelRemovals.add(key.toLowerCase());
            };

            for (const mapping of analysisResult.newMappings || []) {
                const newName = mapping.actualName;  // 可能为 null
                const originalName = String(mapping.originalModel || '').trim();
                const standardName = String(mapping.standardName || '').trim();
                const oldName = originalName || standardName;
                const mappingOnly = mapping.fixType === 'broken-mapping-target' || mapping.fixType === 'remove-invalid';
                const sourceStandard = String(mapping.sourceStandard || '').trim();
                const mappingUpgrade = mapping.fixType === 'mapping-upgrade' && sourceStandard;
                const removeModel = Boolean(mapping.removeModel || mapping.action === 'delete' || mapping.fixType === 'remove-invalid');

                if (mappingUpgrade) {
                    const aliasChanged = standardName && sourceStandard && standardName !== sourceStandard;
                    if (aliasChanged) {
                        if (updateMode === 'append') {
                            // 追加模式：保留旧别名，追加新别名
                            const isVersionUpgrade = mapping.method === 'mapping-version-upgrade';
                            if (!isVersionUpgrade) {
                                // 旧目标失效时仍需要修复旧别名
                                addMappingReplacement(sourceStandard, newName);
                            }
                            addMappingAddition(standardName, newName);
                            addModelReplacement(sourceStandard, standardName);
                        } else {
                            // 覆盖模式：移除旧别名，替换为新别名
                            mappingRemovals.add(sourceStandard.toLowerCase());
                            modelRemovals.add(sourceStandard.toLowerCase());
                            addMappingAddition(standardName, newName);
                            addModelReplacement(sourceStandard, standardName);
                        }
                    } else {
                        addMappingReplacement(sourceStandard, newName);
                    }
                    continue;
                }

                if (removeModel) {
                    addMappingReplacement(oldName, null);
                    addModelRemoval(oldName);
                    addModelRemoval(originalName);
                    addModelRemoval(standardName);
                    continue;
                }

                addMappingReplacement(oldName, newName);
                if (!mappingOnly) {
                    addModelReplacement(oldName, newName);
                }
            }

            if (mappingReplacements.size === 0 &&
                mappingRemovals.size === 0 &&
                mappingAdditions.size === 0 &&
                modelReplacements.size === 0 &&
                modelRemovals.size === 0) {
                return {
                    success: true,
                    message: '无可更新模型'
                };
            }

            let updatedMapping = existingMapping;
            if (shouldUpdateMapping && mappingParsed) {
                updatedMapping = { ...existingMapping };

                // 首先删除无效映射
                for (const key of Object.keys(updatedMapping)) {
                    const keyLower = String(key).toLowerCase();
                    if (mappingRemovals.has(keyLower)) {
                        console.log(`🗑️ 删除无效映射: "${key}" → "${updatedMapping[key]}"`);
                        delete updatedMapping[key];
                    }
                }

                // 然后更新有效映射
                for (const key of Object.keys(updatedMapping)) {
                    const keyLower = String(key).toLowerCase();
                    const keyReplacement = mappingReplacements.get(keyLower);
                    if (keyReplacement) {
                        updatedMapping[key] = keyReplacement.newName;
                    }
                }

                for (const addition of mappingAdditions.values()) {
                    updatedMapping[addition.standardName] = addition.newActual;
                }
            }

            // 更新模型列表：覆盖或追加旧模型
            const currentModels = this.parseModelList(channel.models);
            const newModels = [];
            const seen = new Set();

            if (updateMode === 'append') {
                for (const model of currentModels) {
                    const lower = model.toLowerCase();
                    if (modelRemovals.has(lower)) {
                        continue;
                    }
                    if (!seen.has(lower)) {
                        newModels.push(model);
                        seen.add(lower);
                    }
                }
            } else {
                for (const model of currentModels) {
                    const lower = model.toLowerCase();
                    if (modelRemovals.has(lower)) {
                        continue;
                    }
                    const replacement = modelReplacements.get(lower);
                    const nextModel = replacement ? replacement.newName : model;
                    const nextLower = String(nextModel).toLowerCase();
                    if (!seen.has(nextLower)) {
                        newModels.push(nextModel);
                        seen.add(nextLower);
                    }
                }
            }

            for (const { newName } of modelReplacements.values()) {
                const lower = newName.toLowerCase();
                if (modelRemovals.has(lower)) {
                    continue;
                }
                if (!seen.has(lower)) {
                    newModels.push(newName);
                    seen.add(lower);
                }
            }

            if (modelRemovals.size > 0 && newModels.length > 0) {
                const filtered = [];
                seen.clear();
                for (const model of newModels) {
                    const lower = String(model).toLowerCase();
                    if (modelRemovals.has(lower)) {
                        continue;
                    }
                    if (!seen.has(lower)) {
                        filtered.push(model);
                        seen.add(lower);
                    }
                }
                newModels.length = 0;
                newModels.push(...filtered);
            }

            if (debug) {
                const updatedCount = Math.max(modelReplacements.size, mappingReplacements.size);
                const modeLabel = updateMode === 'append' ? '追加' : '覆盖';
                console.log(`✅ ${modeLabel}旧模型完成: ${updatedCount} 个`);
            }

            // 更新渠道（默认不修改 model_mapping）
            const updateData = {
                ...(channel || {}),
                models: newModels.length === 0 ? null : newModels.join(',')
            };
            if (shouldUpdateMapping && mappingParsed) {
                updateData.model_mapping = JSON.stringify(updatedMapping);
            }

            return await this.updateChannel(updateData);
        } catch (error) {
            console.error(`❌ 更新模型失败:`, error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * 获取一键更新的预览信息（不实际执行更新）
     */
    async previewOneClickUpdate(channelIds = null, options = {}) {
        return await this.oneClickUpdateModels(channelIds, { ...options, dryRun: true });
    }

    // ==================== 配置加密/解密方法 ====================

    static encryptConfig(config, secret = 'default-secret') {
        const encrypted = crypto.AES.encrypt(JSON.stringify(config), secret).toString();
        return { encrypted, timestamp: Date.now() };
    }

    static decryptConfig(encryptedData, secret = 'default-secret') {
        try {
            const bytes = crypto.AES.decrypt(encryptedData.encrypted, secret);
            const decrypted = bytes.toString(crypto.enc.Utf8);
            return JSON.parse(decrypted);
        } catch (error) {
            throw new Error('配置解密失败');
        }
    }
}

module.exports = NewAPIClient;

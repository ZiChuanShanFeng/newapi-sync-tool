/**
 * 定时监控服务
 * 自动检测失效的模型映射并发送告警通知
 */

const NewAPIClient = require('./NewAPIClient');

class ScheduledMonitor {
    constructor(options = {}) {
        this.config = null;
        this.client = null;
        this.timer = null;
        this.isRunning = false;
        this.lastCheckTime = null;
        this.lastCheckResult = null;

        // 默认配置
        this.settings = {
            enabled: false,
            intervalHours: 6,           // 检测间隔（小时）
            onlyEnabledChannels: true,  // 仅检测启用的渠道
            autoFix: false,             // 是否自动修复高置信度映射
            autoFixThreshold: 90,       // 自动修复的置信度阈值
            notifications: {
                webhook: {
                    enabled: false,
                    url: '',
                    secret: ''
                },
                telegram: {
                    enabled: false,
                    botToken: '',
                    chatId: ''
                }
            },
            ...options
        };

        this.listeners = [];
    }

    /**
     * 设置 API 配置
     */
    setConfig(config) {
        this.config = config;
        if (config) {
            this.client = new NewAPIClient(config);
        }
    }

    /**
     * 更新监控设置
     */
    updateSettings(newSettings) {
        const wasEnabled = this.settings.enabled;
        this.settings = { ...this.settings, ...newSettings };

        // 如果启用状态改变，重新调度
        if (wasEnabled !== this.settings.enabled) {
            if (this.settings.enabled) {
                this.start();
            } else {
                this.stop();
            }
        } else if (this.settings.enabled && this.timer) {
            // 如果间隔改变，重新调度
            this.stop();
            this.start();
        }

        return this.settings;
    }

    /**
     * 获取当前设置
     */
    getSettings() {
        return { ...this.settings };
    }

    /**
     * 启动定时监控
     */
    start() {
        if (!this.settings.enabled) {
            console.log('[Monitor] 定时监控未启用');
            return false;
        }

        if (!this.config) {
            console.log('[Monitor] 未配置 API 连接信息');
            return false;
        }

        if (this.timer) {
            this.stop();
        }

        const intervalMs = this.settings.intervalHours * 60 * 60 * 1000;
        console.log(`[Monitor] 启动定时监控，间隔: ${this.settings.intervalHours} 小时`);

        // 立即执行一次检测
        this.runCheck();

        // 设置定时器
        this.timer = setInterval(() => {
            this.runCheck();
        }, intervalMs);

        return true;
    }

    /**
     * 停止定时监控
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            console.log('[Monitor] 定时监控已停止');
        }
    }

    /**
     * 手动触发一次检测
     */
    async runCheck() {
        if (this.isRunning) {
            console.log('[Monitor] 检测正在进行中，跳过');
            return null;
        }

        if (!this.client) {
            console.log('[Monitor] 未配置 API 客户端');
            return null;
        }

        this.isRunning = true;
        this.lastCheckTime = new Date();

        console.log(`[Monitor] 开始定时检测 - ${this.lastCheckTime.toISOString()}`);
        this.emit('checkStart', { time: this.lastCheckTime });

        try {
            // 运行预览模式检测
            const result = await this.client.oneClickUpdateModels(null, {
                dryRun: true,
                onlyEnabled: this.settings.onlyEnabledChannels,
                debug: false
            });

            this.lastCheckResult = {
                time: this.lastCheckTime,
                success: result.success,
                scannedChannels: result.results?.scannedChannels || 0,
                brokenMappings: result.results?.brokenMappings || [],
                newMappings: result.results?.newMappings || [],
                duration: result.duration
            };

            const brokenCount = this.lastCheckResult.brokenMappings.length;
            const fixableCount = this.lastCheckResult.newMappings.filter(m => m.actualName).length;

            console.log(`[Monitor] 检测完成 - 扫描: ${this.lastCheckResult.scannedChannels}, 失效: ${brokenCount}, 可修复: ${fixableCount}`);

            // 如果发现失效映射，发送告警
            if (brokenCount > 0) {
                await this.sendAlerts(this.lastCheckResult);

                // 如果启用自动修复
                if (this.settings.autoFix && fixableCount > 0) {
                    await this.autoFixMappings(this.lastCheckResult);
                }
            }

            this.emit('checkComplete', this.lastCheckResult);
            return this.lastCheckResult;

        } catch (error) {
            console.error('[Monitor] 检测失败:', error.message);
            this.lastCheckResult = {
                time: this.lastCheckTime,
                success: false,
                error: error.message
            };
            this.emit('checkError', { error: error.message });
            return this.lastCheckResult;

        } finally {
            this.isRunning = false;
        }
    }

    /**
     * 发送告警通知
     */
    async sendAlerts(checkResult) {
        const alerts = [];

        // Webhook 通知
        if (this.settings.notifications.webhook.enabled) {
            alerts.push(this.sendWebhookAlert(checkResult));
        }

        // Telegram 通知
        if (this.settings.notifications.telegram.enabled) {
            alerts.push(this.sendTelegramAlert(checkResult));
        }

        if (alerts.length > 0) {
            const results = await Promise.allSettled(alerts);
            results.forEach((r, i) => {
                if (r.status === 'rejected') {
                    console.error(`[Monitor] 告警发送失败:`, r.reason);
                }
            });
        }
    }

    /**
     * 发送 Webhook 告警
     */
    async sendWebhookAlert(checkResult) {
        const { url, secret } = this.settings.notifications.webhook;
        const axios = require('axios');
        const targetUrl = String(url || '').trim();
        if (!targetUrl) {
            throw new Error('Webhook URL is empty');
        }

        if (this.isFeishuWebhook(targetUrl)) {
            const payload = this.buildFeishuWebhookPayload(checkResult, secret);
            const headers = { 'Content-Type': 'application/json; charset=utf-8' };
            const response = await axios.post(targetUrl, payload, { headers, timeout: 10000 });
            const data = response?.data;
            const rawCode = data?.code ?? data?.StatusCode;
            if (rawCode != null) {
                const code = Number(rawCode);
                if (!Number.isNaN(code) && code !== 0) {
                    const msg = data?.msg ?? data?.StatusMessage ?? data?.message ?? 'unknown error';
                    throw new Error(`Feishu webhook error: code=${code} msg=${msg}`);
                }
            }
            console.log('[Monitor] Feishu webhook alert sent');
            return;
        }

        const brokenMappings = Array.isArray(checkResult?.brokenMappings) ? checkResult.brokenMappings : [];
        const newMappings = Array.isArray(checkResult?.newMappings) ? checkResult.newMappings : [];

        const payload = {
            event: 'model_mapping_alert',
            timestamp: new Date().toISOString(),
            summary: {
                scannedChannels: checkResult?.scannedChannels ?? 0,
                brokenMappings: brokenMappings.length,
                fixableMappings: newMappings.filter(m => m && m.actualName).length
            },
            details: {
                brokenMappings: brokenMappings.slice(0, 20).map(m => ({
                    ...m,
                    suggestion: this.getSuggestionForBrokenMapping(m, newMappings)
                })), // 限制数量
                suggestedFixes: newMappings.slice(0, 20)
            }
        };

        const headers = {
            'Content-Type': 'application/json'
        };

        if (secret) {
            const crypto = require('crypto');
            const signature = crypto
                .createHmac('sha256', String(secret))
                .update(JSON.stringify(payload))
                .digest('hex');
            headers['X-Signature'] = signature;
        }

        await axios.post(targetUrl, payload, { headers, timeout: 10000 });
        console.log('[Monitor] Webhook 告警已发送');
    }

    isFeishuWebhook(url) {
        return /https?:\/\/open\.(feishu|larksuite)\.(cn|com)\/open-apis\/bot\/v2\/hook\//i.test(String(url || ''));
    }

    buildFeishuWebhookPayload(checkResult, secret) {
        const text = this.buildFeishuText(checkResult);
        const payload = {
            msg_type: 'text',
            content: { text }
        };

        const secretKey = secret ? String(secret).trim() : '';
        if (secretKey) {
            const crypto = require('crypto');
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const sign = crypto
                .createHmac('sha256', secretKey)
                .update(`${timestamp}\n${secretKey}`)
                .digest('base64');
            payload.timestamp = timestamp;
            payload.sign = sign;
        }

        return payload;
    }

    buildFeishuText(checkResult) {
        const brokenMappings = Array.isArray(checkResult?.brokenMappings) ? checkResult.brokenMappings : [];
        const newMappings = Array.isArray(checkResult?.newMappings) ? checkResult.newMappings : [];
        const scannedChannels = Number(checkResult?.scannedChannels || 0);
        const brokenCount = brokenMappings.length;
        const fixableCount = newMappings.filter(m => m && m.actualName).length;

        const lines = [
            'NewAPI model mapping alert',
            `Time: ${new Date().toISOString()}`,
            `Scanned channels: ${scannedChannels}`,
            `Broken mappings: ${brokenCount}`,
            `Fixable mappings: ${fixableCount}`
        ];

        if (brokenCount > 0) {
            lines.push('', 'Broken examples:');
            brokenMappings.slice(0, 5).forEach((m) => {
                const channelLabel = m?.channelName ?? m?.channelId ?? 'unknown';
                const modelLabel = m?.originalModel ?? m?.standardName ?? 'unknown';
                const reason = m?.reason ? `原因: ${m.reason}` : '原因: 未知';
                const suggestion = this.getSuggestionForBrokenMapping(m, newMappings);
                const suggestionText = suggestion ? `建议: ${suggestion}` : null;
                const extra = suggestionText ? `${reason} | ${suggestionText}` : reason;
                lines.push(`- ${channelLabel}: ${modelLabel} | ${extra}`);
            });
            if (brokenCount > 5) {
                lines.push(`... ${brokenCount - 5} more`);
            }
        }

        return lines.join('\n');
    }

    getSuggestionForBrokenMapping(brokenMapping, newMappings) {
        if (!brokenMapping) return '';
        const keyCandidates = [
            brokenMapping?.originalModel,
            brokenMapping?.standardName,
            brokenMapping?.expectedModel,
            brokenMapping?.sourceStandard
        ]
            .map(v => String(v || '').trim().toLowerCase())
            .filter(Boolean);

        const match = keyCandidates.length > 0
            ? (newMappings || []).find((m) => {
                const values = [
                    m?.originalModel,
                    m?.standardName,
                    m?.sourceStandard
                ]
                    .map(v => String(v || '').trim().toLowerCase())
                    .filter(Boolean);
                return values.some(v => keyCandidates.includes(v));
            })
            : null;

        if (match) {
            if (match.removeModel || match.action === 'delete' || match.actualName == null) {
                return '删除';
            }
            if (match.actualName) {
                return '更新';
            }
        }

        const reason = String(brokenMapping?.reason || '').trim();
        if (reason) {
            if (reason.includes('建议删除') || reason.includes('删除')) return '删除';
            if (reason.includes('建议更新') || reason.includes('升级') || reason.includes('更新')) return '更新';
        }

        return '';
    }

    /**
     * 发送 Telegram 告警
     */
    async sendTelegramAlert(checkResult) {
        const { botToken, chatId } = this.settings.notifications.telegram;
        if (!botToken || !chatId) return;

        const brokenCount = checkResult.brokenMappings.length;
        const fixableCount = checkResult.newMappings.filter(m => m.actualName).length;

        // 构建消息
        let message = `*NewAPI 模型映射告警*\n\n`;
        message += `检测时间: ${new Date().toLocaleString('zh-CN')}\n`;
        message += `扫描渠道: ${checkResult.scannedChannels}\n`;
        message += `失效映射: ${brokenCount}\n`;
        message += `可修复: ${fixableCount}\n\n`;

        if (brokenCount > 0) {
            message += `*失效详情:*\n`;

            // 按渠道分组
            const byChannel = {};
            checkResult.brokenMappings.forEach(m => {
                const key = `${m.channelName} (#${m.channelId})`;
                if (!byChannel[key]) byChannel[key] = [];
                byChannel[key].push(m);
            });

            Object.entries(byChannel).slice(0, 5).forEach(([channel, mappings]) => {
                message += `\n_${this.escapeMarkdown(channel)}_\n`;
                mappings.slice(0, 3).forEach(m => {
                    const reason = m?.reason ? this.escapeMarkdown(m.reason) : '未知';
                    const suggestion = this.getSuggestionForBrokenMapping(m, checkResult.newMappings);
                    const suggestionText = suggestion ? this.escapeMarkdown(suggestion) : '无';
                    message += `  - ${this.escapeMarkdown(m.originalModel)} | 原因: ${reason} | 建议: ${suggestionText}\n`;
                });
                if (mappings.length > 3) {
                    message += `  ... 还有 ${mappings.length - 3} 个\n`;
                }
            });

            if (Object.keys(byChannel).length > 5) {
                message += `\n... 还有 ${Object.keys(byChannel).length - 5} 个渠道\n`;
            }
        }

        message += `\n请登录管理面板查看详情并处理。`;

        const axios = require('axios');
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        }, { timeout: 10000 });

        console.log('[Monitor] Telegram 告警已发送');
    }

    /**
     * 转义 Markdown 特殊字符
     */
    escapeMarkdown(text) {
        if (!text) return '';
        return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    }

    /**
     * 自动修复高置信度映射
     */
    async autoFixMappings(checkResult) {
        const threshold = this.settings.autoFixThreshold;
        const highConfidenceFixes = checkResult.newMappings.filter(
            m => m.actualName && m.confidence >= threshold
        );

        if (highConfidenceFixes.length === 0) {
            console.log('[Monitor] 没有高置信度的映射需要自动修复');
            return;
        }

        console.log(`[Monitor] 自动修复 ${highConfidenceFixes.length} 个高置信度映射 (阈值: ${threshold}%)`);

        // 按渠道分组
        const byChannel = {};
        highConfidenceFixes.forEach(fix => {
            if (!byChannel[fix.channelId]) {
                byChannel[fix.channelId] = {
                    channelId: fix.channelId,
                    channelName: fix.channelName,
                    fixes: []
                };
            }
            byChannel[fix.channelId].fixes.push(fix);
        });

        // 执行修复
        for (const channelData of Object.values(byChannel)) {
            try {
                // 这里需要调用实际的修复逻辑
                // 暂时只记录日志
                console.log(`[Monitor] 自动修复渠道 ${channelData.channelName}: ${channelData.fixes.length} 个映射`);
                this.emit('autoFix', channelData);
            } catch (error) {
                console.error(`[Monitor] 自动修复渠道 ${channelData.channelName} 失败:`, error.message);
            }
        }
    }

    /**
     * 添加事件监听器
     */
    on(event, callback) {
        this.listeners.push({ event, callback });
    }

    /**
     * 触发事件
     */
    emit(event, data) {
        this.listeners
            .filter(l => l.event === event)
            .forEach(l => {
                try {
                    l.callback(data);
                } catch (e) {
                    console.error(`[Monitor] 事件处理器错误:`, e);
                }
            });
    }

    /**
     * 获取状态信息
     */
    getStatus() {
        return {
            enabled: this.settings.enabled,
            isRunning: this.isRunning,
            hasTimer: !!this.timer,
            intervalHours: this.settings.intervalHours,
            lastCheckTime: this.lastCheckTime,
            lastCheckResult: this.lastCheckResult ? {
                success: this.lastCheckResult.success,
                scannedChannels: this.lastCheckResult.scannedChannels,
                brokenMappings: this.lastCheckResult.brokenMappings?.length || 0,
                fixableMappings: this.lastCheckResult.newMappings?.filter(m => m.actualName).length || 0,
                duration: this.lastCheckResult.duration
            } : null,
            notifications: {
                webhook: this.settings.notifications.webhook.enabled,
                telegram: this.settings.notifications.telegram.enabled
            }
        };
    }
}

// 单例模式
let instance = null;

module.exports = {
    ScheduledMonitor,
    getInstance: () => {
        if (!instance) {
            instance = new ScheduledMonitor();
        }
        return instance;
    }
};



import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { getSettings, saveSettings, getProductKnowledge, saveProductKnowledge } from '../shared/storage';
import {
  DEFAULT_SETTINGS,
  type AIProvider,
  type AppSettings,
  type SmsProvider,
  type ProductKnowledgeItem,
} from '../shared/types';
import { getDirectSendConfigError } from '../shared/ai-config';

type NavKey = 'ai' | 'notify' | 'prompt' | 'stats' | 'advanced' | 'contact';

function Options(): JSX.Element {
  const [nav, setNav] = useState<NavKey>('ai');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  async function handleSave(): Promise<void> {
    await saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function patchAI(patch: Partial<AppSettings['ai']>): void {
    setSettings((s) => ({ ...s, ai: { ...s.ai, ...patch } }));
  }

  function patchNotify(patch: Partial<AppSettings['notification']>): void {
    setSettings((s) => ({ ...s, notification: { ...s.notification, ...patch } }));
  }

  const navItems: { key: NavKey; label: string }[] = [
    { key: 'ai', label: '🤖 AI 设置' },
    { key: 'notify', label: '📢 下单通知' },
    { key: 'prompt', label: '💬 话术配置' },
    { key: 'stats', label: '📊 数据统计' },
    { key: 'advanced', label: '⚙️ 高级设置' },
  ];

  const navItemsWithContact = [
    ...navItems,
    { key: 'contact' as const, label: 'Telegram 联系' },
  ];

  function unusedHandleDirectSendAuthorizedChange1(enabled: boolean): void {
    if (enabled) {
      const configError = getDirectSendConfigError(settings.ai);
      if (configError) {
        window.alert(`${configError}\n请先完善 AI 配置后再开启自动直发授权。`);
        return;
      }
    }

    patchAI({ directSendAuthorized: enabled, autoReplyEnabled: enabled, reviewModeEnabled: false });
  }

  function unusedHandleDirectSendAuthorizedChange2(enabled: boolean): void {
    if (enabled) {
      const configError = getDirectSendConfigError(settings.ai);
      if (configError) {
        window.alert(`${configError}\n请先完善 AI 配置后再开启自动直发授权。`);
        return;
      }
    }

    patchAI({ directSendAuthorized: enabled, autoReplyEnabled: enabled, reviewModeEnabled: false });
  }

  return (
    <div style={styles.page}>
      {/* 顶部标题栏 */}
      <div style={styles.topBar}>
        <span style={styles.topTitle}>🐟 闲鱼智能客服助手</span>
        <span style={styles.version}>v1.0.1</span>
      </div>

      <div style={styles.body}>
        {/* 左侧导航 */}
        <nav style={styles.nav}>
          {navItemsWithContact.map((item) => (
            <button
              key={item.key}
              style={{
                ...styles.navItem,
                ...(nav === item.key ? styles.navItemActive : {}),
              }}
              onClick={() => setNav(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* 右侧内容 */}
        <main style={styles.main}>
          {nav === 'ai' && (
            <AISettings settings={settings} patchAI={patchAI} />
          )}
          {nav === 'notify' && (
            <NotifySettings settings={settings} patchNotify={patchNotify} />
          )}
          {nav === 'prompt' && (
            <PromptSettings settings={settings} patchAI={patchAI} />
          )}
          {nav === 'stats' && <StatsPage />}
          {nav === 'advanced' && <AdvancedPage />}
          {nav === 'contact' && <ContactPage />}

          {/* 保存按钮（统计和高级页不需要） */}
          {nav !== 'stats' && nav !== 'advanced' && nav !== 'contact' && (
            <div style={styles.saveRow}>
              <button style={styles.saveBtn} onClick={handleSave}>
                {saved ? '✅ 已保存' : '💾 保存配置'}
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ─── AI 设置面板 ─── */
function AISettings({
  settings,
  patchAI,
}: {
  settings: AppSettings;
  patchAI: (p: Partial<AppSettings['ai']>) => void;
}): JSX.Element {
  function handleDirectSendAuthorizedChange(enabled: boolean): void {
    if (enabled) {
      const configError = getDirectSendConfigError(settings.ai);
      if (configError) {
        window.alert(`${configError}\n请先完善 AI 配置后再开启自动直发授权。`);
        return;
      }
    }

    patchAI({ directSendAuthorized: enabled, autoReplyEnabled: enabled, reviewModeEnabled: false });
  }

  const providers: { value: AIProvider; label: string; baseUrl: string }[] = [
    { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com' },
    { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
    { value: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode' },
    { value: 'custom', label: '自定义', baseUrl: '' },
  ];

  return (
    <div>
      <h2 style={styles.sectionH2}>AI 模型配置</h2>
      <div style={styles.card}>
        <Label>AI 提供商</Label>
        <div style={styles.radioGroup}>
          {providers.map((p) => (
            <label key={p.value} style={styles.radioLabel}>
              <input
                type="radio"
                name="provider"
                value={p.value}
                checked={settings.ai.provider === p.value}
                onChange={() =>
                  patchAI({
                    provider: p.value,
                    baseUrl: p.baseUrl || settings.ai.baseUrl,
                  })
                }
              />
              {p.label}
            </label>
          ))}
        </div>

        <Label>API Key</Label>
        <input
          style={styles.input}
          type="password"
          placeholder="请输入 API Key"
          value={settings.ai.apiKey}
          onChange={(e) => patchAI({ apiKey: e.target.value })}
        />

        <Label>Base URL</Label>
        <input
          style={styles.input}
          type="text"
          value={settings.ai.baseUrl}
          onChange={(e) => patchAI({ baseUrl: e.target.value })}
        />

        <Label>模型名称</Label>
        <input
          style={styles.input}
          type="text"
          placeholder="如 deepseek-chat / gpt-4o"
          value={settings.ai.model}
          onChange={(e) => patchAI({ model: e.target.value })}
        />

        <Label>温度 (Temperature): {settings.ai.temperature}</Label>
        <input
          style={{ width: '100%', marginBottom: '16px' }}
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={settings.ai.temperature}
          onChange={(e) => patchAI({ temperature: parseFloat(e.target.value) })}
        />

        <Label>最大回复长度 (tokens)</Label>
        <input
          style={styles.input}
          type="number"
          min="100"
          max="4000"
          value={settings.ai.maxTokens}
          onChange={(e) => patchAI({ maxTokens: parseInt(e.target.value, 10) })}
        />
      </div>

      <h2 style={styles.sectionH2}>自动直发授权</h2>
      <div style={styles.card}>
        <p style={{ ...styles.hint, marginTop: 0, marginBottom: '12px', fontSize: '13px', color: '#555' }}>
          关闭时，扩展不会自动向买家发送 AI 回复。开启前请确认你已知晓：系统会在无人值守时自动读取买家消息、调用你配置的 AI 服务，并直接发送回复。
        </p>
        <CheckItem
          label="我已知晓并同意启用 AI 自动直发"
          checked={settings.ai.directSendAuthorized}
          onChange={handleDirectSendAuthorizedChange}
        />
      </div>

    </div>
  );
}

/* ─── 通知设置面板 ─── */
function NotifySettings({
  settings,
  patchNotify,
}: {
  settings: AppSettings;
  patchNotify: (p: Partial<AppSettings['notification']>) => void;
}): JSX.Element {
  const smsProviders: { value: SmsProvider; label: string }[] = [
    { value: 'aliyun', label: '阿里云短信' },
    { value: 'tencent', label: '腾讯云短信' },
  ];

  return (
    <div>
      <p style={{ ...styles.hint, marginBottom: '16px', fontSize: '14px' }}>
        当买家下单后，通过以下渠道实时通知您，避免漏单。
      </p>

      {/* ── 浏览器桌面通知 ── */}
      <h2 style={styles.sectionH2}>浏览器桌面通知</h2>
      <div style={styles.card}>
        <CheckItem
          label="买家下单时弹出桌面通知"
          checked={settings.notification.browserEnabled}
          onChange={(v) => patchNotify({ browserEnabled: v })}
        />
        <p style={styles.hint}>需要浏览器保持打开，无需任何额外配置。</p>
      </div>

      {/* ── 钉钉机器人 ── */}
      <h2 style={styles.sectionH2}>钉钉机器人</h2>
      <div style={styles.card}>
        <CheckItem
          label="下单时推送到钉钉群"
          checked={settings.notification.dingtalkEnabled}
          onChange={(v) => patchNotify({ dingtalkEnabled: v })}
        />
        {settings.notification.dingtalkEnabled && (
          <>
            <Label>Webhook 地址</Label>
            <input
              style={styles.input}
              type="text"
              placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
              value={settings.notification.dingtalkWebhook ?? ''}
              onChange={(e) => patchNotify({ dingtalkWebhook: e.target.value })}
            />
            <Label>加签 Secret（可选，安全设置中启用加签时填写）</Label>
            <input
              style={styles.input}
              type="password"
              placeholder="SECxxx..."
              value={settings.notification.dingtalkSecret ?? ''}
              onChange={(e) => patchNotify({ dingtalkSecret: e.target.value })}
            />
            <p style={styles.hint}>
              在钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义机器人，复制 Webhook 地址。
            </p>
          </>
        )}
      </div>

      {/* ── 飞书机器人 ── */}
      <h2 style={styles.sectionH2}>飞书机器人</h2>
      <div style={styles.card}>
        <CheckItem
          label="下单时推送到飞书群"
          checked={settings.notification.feishuEnabled}
          onChange={(v) => patchNotify({ feishuEnabled: v })}
        />
        {settings.notification.feishuEnabled && (
          <>
            <Label>Webhook 地址</Label>
            <input
              style={styles.input}
              type="text"
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
              value={settings.notification.feishuWebhook ?? ''}
              onChange={(e) => patchNotify({ feishuWebhook: e.target.value })}
            />
            <p style={styles.hint}>
              在飞书群 → 群设置 → 群机器人 → 添加机器人 → 自定义机器人，复制 Webhook 地址。
            </p>
          </>
        )}
      </div>

      {/* ── Telegram Bot ── */}
      <h2 style={styles.sectionH2}>Telegram Bot</h2>
      <div style={styles.card}>
        <CheckItem
          label="下单时推送到 Telegram"
          checked={settings.notification.telegramEnabled}
          onChange={(v) => patchNotify({ telegramEnabled: v })}
        />
        {settings.notification.telegramEnabled && (
          <>
            <Label>Bot Token</Label>
            <input
              style={styles.input}
              type="password"
              placeholder="123456789:AABBccdd..."
              value={settings.notification.telegramBotToken ?? ''}
              onChange={(e) => patchNotify({ telegramBotToken: e.target.value })}
            />
            <Label>Chat ID</Label>
            <input
              style={styles.input}
              type="text"
              placeholder="你的用户 ID 或群组 ID，如 123456789"
              value={settings.notification.telegramChatId ?? ''}
              onChange={(e) => patchNotify({ telegramChatId: e.target.value })}
            />
            <p style={styles.hint}>
              通过 @BotFather 创建 Bot 获取 Token；向 @userinfobot 发消息获取你的 Chat ID。
              国内需要代理才能访问 Telegram。
            </p>
          </>
        )}
      </div>

      {/* ── 短信通知 ── */}
      <h2 style={styles.sectionH2}>短信</h2>
      <div style={styles.card}>
        <CheckItem
          label="下单时发送短信提醒"
          checked={settings.notification.smsEnabled}
          onChange={(v) => patchNotify({ smsEnabled: v })}
        />
        {settings.notification.smsEnabled && (
          <>
            <Label>短信服务商</Label>
            <select
              style={styles.select}
              value={settings.notification.smsProvider}
              onChange={(e) =>
                patchNotify({ smsProvider: e.target.value as SmsProvider })
              }
            >
              {smsProviders.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <Label>AccessKey ID</Label>
            <input
              style={styles.input}
              type="password"
              value={settings.notification.smsAccessKey ?? ''}
              onChange={(e) => patchNotify({ smsAccessKey: e.target.value })}
            />
            <Label>AccessKey Secret</Label>
            <input
              style={styles.input}
              type="password"
              value={settings.notification.smsSecretKey ?? ''}
              onChange={(e) => patchNotify({ smsSecretKey: e.target.value })}
            />
            <Label>短信签名</Label>
            <input
              style={styles.input}
              type="text"
              value={settings.notification.smsSignName ?? ''}
              onChange={(e) => patchNotify({ smsSignName: e.target.value })}
            />
            <Label>短信模板 Code</Label>
            <input
              style={styles.input}
              type="text"
              value={settings.notification.smsTemplateCode ?? ''}
              onChange={(e) => patchNotify({ smsTemplateCode: e.target.value })}
            />
            <Label>接收手机号</Label>
            <input
              style={styles.input}
              type="tel"
              value={settings.notification.smsPhone ?? ''}
              onChange={(e) => patchNotify({ smsPhone: e.target.value })}
            />
            <p style={styles.hint}>短信通知需要企业资质及已备案的短信签名。</p>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── 话术配置面板 ─── */
function PromptSettings({
  settings,
  patchAI,
}: {
  settings: AppSettings;
  patchAI: (p: Partial<AppSettings['ai']>) => void;
}): JSX.Element {
  const [products, setProducts] = useState<ProductKnowledgeItem[]>([]);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [productSaved, setProductSaved] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 加载已保存的商品知识
  useEffect(() => {
    getProductKnowledge().then(setProducts);
  }, []);

  // 获取在售商品
  async function handleFetchProducts(): Promise<void> {
    setFetchLoading(true);
    setFetchError('');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'FETCH_MY_PRODUCTS' }) as {
        success: boolean;
        products: ProductKnowledgeItem[];
        error?: string;
      };
      if (resp?.success && resp.products.length > 0) {
        setProducts(resp.products);
        setFetchError('');
      } else {
        setFetchError(resp?.error || '未获取到商品，请确保已登录闲鱼且有在售商品');
      }
    } catch {
      setFetchError('获取失败，请确保已打开闲鱼页面');
    }
    setFetchLoading(false);
  }

  // 更新单个商品字段
  function updateProduct(itemId: string, patch: Partial<ProductKnowledgeItem>): void {
    setProducts(prev => prev.map(p => p.itemId === itemId ? { ...p, ...patch } : p));
  }

  // 保存商品知识
  async function handleSaveProducts(): Promise<void> {
    await saveProductKnowledge(products);
    setProductSaved(true);
    setTimeout(() => setProductSaved(false), 2000);
  }

  return (
    <div>
      {/* Agent 系统说明 */}
      <h2 style={{ ...styles.sectionH2, marginTop: 0 }}>AI Agent 智能分流系统</h2>
      <div style={styles.card}>
        <p style={{ fontSize: '13px', color: '#555', lineHeight: '1.8', marginBottom: '12px' }}>
          系统会自动识别买家消息意图，分配给不同的专业 Agent 处理：
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[
            { icon: '🏷', name: '砍价助手', desc: '买家议价时启用，态度友好但坚定守价', tag: '内置策略' },
            { icon: '🔍', name: '商品咨询', desc: '买家询问商品细节时启用，如实专业回答', tag: '内置策略' },
            { icon: '💬', name: '通用回复', desc: '其他场景（打招呼、闲聊等），可自定义提示词', tag: '可自定义' },
          ].map(agent => (
            <div key={agent.name} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', background: '#f9f9f9', borderRadius: '8px' }}>
              <span style={{ fontSize: '18px' }}>{agent.icon}</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 600, fontSize: '13px' }}>{agent.name}</span>
                <span style={{ fontSize: '12px', color: '#888', marginLeft: '8px' }}>{agent.desc}</span>
              </div>
              <span style={{
                fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
                background: agent.tag === '可自定义' ? '#e6f7ff' : '#f0f0f0',
                color: agent.tag === '可自定义' ? '#1890ff' : '#999',
              }}>{agent.tag}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 通用回复 Agent 提示词 */}
      <h2 style={styles.sectionH2}>通用回复 Agent 提示词</h2>
      <div style={styles.card}>
        <p style={{ ...styles.hint, marginBottom: '8px', marginTop: 0 }}>
          仅用于通用回复场景。砍价和商品咨询由内置专业策略处理，不受此设置影响。
        </p>
        <textarea
          style={{ ...styles.input, height: '120px', resize: 'vertical' }}
          value={settings.ai.systemPrompt}
          onChange={(e) => patchAI({ systemPrompt: e.target.value })}
          placeholder="请输入通用回复的角色设定..."
        />
      </div>

      {/* 通用知识 */}
      <h2 style={styles.sectionH2}>通用知识（适用于所有商品）</h2>
      <div style={styles.card}>
        <p style={{ ...styles.hint, marginBottom: '8px', marginTop: 0 }}>
          填写适用于所有商品的通用信息，如包邮规则、退换政策、发货时间等。
        </p>
        <textarea
          style={{ ...styles.input, height: '100px', resize: 'vertical' }}
          value={settings.ai.knowledgeBase}
          onChange={(e) => patchAI({ knowledgeBase: e.target.value })}
          placeholder={`例如：\n省内包邮，省外+10\n支持当面交易和验货\n一般当天发货，顺丰/圆通`}
        />
      </div>

      {/* 商品专属配置 */}
      <h2 style={styles.sectionH2}>商品专属配置</h2>
      <div style={styles.card}>
        <p style={{ ...styles.hint, marginBottom: '12px', marginTop: 0 }}>
          从闲鱼拉取在售商品，为每个商品单独设置底价和补充说明。AI 回复买家时会自动匹配对应商品的配置。
        </p>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <button
            onClick={handleFetchProducts}
            disabled={fetchLoading}
            style={{
              padding: '8px 16px', border: '1px solid #ddd', borderRadius: '8px',
              background: fetchLoading ? '#f5f5f5' : '#fff', cursor: fetchLoading ? 'default' : 'pointer',
              fontSize: '13px',
            }}
          >
            {fetchLoading ? '获取中...' : '获取在售商品'}
          </button>
          {products.length > 0 && (
            <button
              onClick={handleSaveProducts}
              style={{
                padding: '8px 16px', border: 'none', borderRadius: '8px',
                background: '#FFE512', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
              }}
            >
              {productSaved ? '已保存' : '保存商品配置'}
            </button>
          )}
        </div>

        {fetchError && (
          <p style={{ fontSize: '13px', color: '#ff4d4f', marginBottom: '12px' }}>{fetchError}</p>
        )}

        {products.length === 0 && !fetchLoading && !fetchError && (
          <p style={{ fontSize: '13px', color: '#999', textAlign: 'center', padding: '20px 0' }}>
            点击"获取在售商品"加载您的闲鱼在售商品列表
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {products.map(product => {
            const isExpanded = expandedId === product.itemId;
            const hasConfig = !!(product.bottomPrice || product.extraNote);
            return (
              <div key={product.itemId} style={{
                border: '1px solid #eee', borderRadius: '8px',
                overflow: 'hidden', background: '#fafafa',
              }}>
                {/* 商品标题行 */}
                <div
                  onClick={() => setExpandedId(isExpanded ? null : product.itemId)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 14px', cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: '12px', color: '#999' }}>{isExpanded ? '▼' : '▶'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {product.title}
                    </div>
                  </div>
                  <span style={{ fontSize: '13px', color: '#ff6600', fontWeight: 600, flexShrink: 0 }}>
                    {product.price ? `¥${product.price}` : ''}
                  </span>
                  {hasConfig && (
                    <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '4px', background: '#e6f7ff', color: '#1890ff', flexShrink: 0 }}>
                      已配置
                    </span>
                  )}
                </div>

                {/* 展开的配置区域 */}
                {isExpanded && (
                  <div style={{ padding: '0 14px 14px', borderTop: '1px solid #eee' }}>
                    <p style={styles.label}>底价（AI 砍价时绝不低于此价）</p>
                    <input
                      type="text"
                      style={{ ...styles.input, width: '120px' }}
                      value={product.bottomPrice}
                      onChange={(e) => updateProduct(product.itemId, { bottomPrice: e.target.value })}
                      placeholder="例如 350"
                    />
                    <p style={styles.label}>补充说明</p>
                    <textarea
                      style={{ ...styles.input, height: '80px', resize: 'vertical' }}
                      value={product.extraNote}
                      onChange={(e) => updateProduct(product.itemId, { extraNote: e.target.value })}
                      placeholder="补充商品信息、卖点、瑕疵、包邮规则等..."
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── 数据统计面板（占位） ─── */
function StatsPage(): JSX.Element {
  return (
    <div>
      <h2 style={styles.sectionH2}>数据统计</h2>
      <div style={styles.card}>
        <p style={styles.hint}>统计功能开发中，敬请期待。</p>
      </div>
    </div>
  );
}

/* ─── 高级设置面板（占位） ─── */
function AdvancedPage(): JSX.Element {
  async function handleReset(): Promise<void> {
    if (confirm('确定要重置所有设置吗？此操作不可撤销。')) {
      await saveSettings(DEFAULT_SETTINGS);
      location.reload();
    }
  }

  return (
    <div>
      <h2 style={styles.sectionH2}>高级设置</h2>
      <div style={styles.card}>
        <button style={{ ...styles.saveBtn, background: '#f5222d' }} onClick={handleReset}>
          🗑️ 重置所有设置
        </button>
      </div>
    </div>
  );
}

/* ─── 通用小组件 ─── */
function Label({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={styles.label}>{children}</div>;
}

function CheckItem({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label style={styles.checkItem}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginRight: '8px' }}
      />
      {label}
    </label>
  );
}

/* ─── 样式 ─── */
function ContactPage(): JSX.Element {
  return (
    <div>
      <h2 style={styles.sectionH2}>联系与反馈</h2>
      <div style={styles.card}>
        <div style={styles.contactIntro}>
          欢迎通过 Telegram 联系我提意见，或者加入群组交流反馈。
        </div>

        <div style={styles.contactBlock}>
          <div style={styles.contactLabel}>Telegram 账号</div>
          <a
            href="https://t.me/Global_Acc_Hub"
            target="_blank"
            rel="noreferrer"
            style={styles.contactLink}
          >
            @Global_Acc_Hub
          </a>
        </div>

        <div style={styles.contactBlock}>
          <div style={styles.contactLabel}>Telegram 群组</div>
          <a
            href="https://t.me/+O05zNZ3fUzQ5ZmY0"
            target="_blank"
            rel="noreferrer"
            style={styles.contactLink}
          >
            加入意见反馈群
          </a>
        </div>

        <div style={styles.hint}>
          如果 Telegram 无法直接打开，可以复制链接到浏览器中访问。
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#f5f5f5',
    display: 'flex',
    flexDirection: 'column',
  },
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 32px',
    background: '#FFE512',
    color: '#1A1A1A',
  },
  topTitle: {
    fontSize: '20px',
    fontWeight: 700,
  },
  version: {
    fontSize: '13px',
    opacity: 0.8,
  },
  body: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
  },
  nav: {
    width: '200px',
    background: '#fff',
    borderRight: '1px solid #eee',
    padding: '16px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  navItem: {
    display: 'block',
    width: '100%',
    padding: '12px 24px',
    textAlign: 'left',
    background: 'none',
    border: 'none',
    fontSize: '14px',
    color: '#555',
    cursor: 'pointer',
    borderRadius: '0',
  },
  navItemActive: {
    background: '#fff7f0',
    color: '#FFE512',
    fontWeight: 600,
    borderLeft: '3px solid #FFE512',
  },
  main: {
    flex: 1,
    padding: '32px',
    overflowY: 'auto',
    maxWidth: '720px',
  },
  sectionH2: {
    fontSize: '16px',
    fontWeight: 600,
    color: '#333',
    marginBottom: '12px',
    marginTop: '24px',
  },
  card: {
    background: '#fff',
    borderRadius: '12px',
    padding: '20px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    marginBottom: '8px',
  },
  label: {
    fontSize: '13px',
    color: '#666',
    marginBottom: '6px',
    marginTop: '12px',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #ddd',
    borderRadius: '8px',
    fontSize: '14px',
    marginBottom: '4px',
    outline: 'none',
  },
  select: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #ddd',
    borderRadius: '8px',
    fontSize: '14px',
    marginBottom: '4px',
    background: '#fff',
  },
  radioGroup: {
    display: 'flex',
    gap: '16px',
    flexWrap: 'wrap',
    marginBottom: '4px',
  },
  radioLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '14px',
    cursor: 'pointer',
  },
  checkItem: {
    display: 'flex',
    alignItems: 'center',
    fontSize: '14px',
    cursor: 'pointer',
    marginBottom: '12px',
  },
  hint: {
    fontSize: '12px',
    color: '#999',
    marginTop: '8px',
  },
  contactIntro: {
    fontSize: '14px',
    color: '#444',
    lineHeight: 1.7,
    marginBottom: '20px',
  },
  contactBlock: {
    padding: '16px',
    border: '1px solid #f0f0f0',
    borderRadius: '10px',
    background: '#fafafa',
    marginBottom: '12px',
  },
  contactLabel: {
    fontSize: '13px',
    color: '#666',
    marginBottom: '8px',
  },
  contactLink: {
    color: '#0a66c2',
    fontSize: '15px',
    fontWeight: 600,
    textDecoration: 'none',
    wordBreak: 'break-all',
  },
  saveRow: {
    marginTop: '24px',
  },
  saveBtn: {
    padding: '12px 32px',
    background: '#FFE512',
    color: '#1A1A1A',
    border: 'none',
    borderRadius: '8px',
    fontSize: '15px',
    cursor: 'pointer',
    fontWeight: 600,
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>
);

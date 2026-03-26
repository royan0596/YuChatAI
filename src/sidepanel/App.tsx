import React, { useEffect, useState, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { getSettings, getStats, patchStats, getMessageLogs, type MessageLogEntry } from '../shared/storage';
import type { AppSettings, PopupStats } from '../shared/types';

const BRAND = {
  yellow: '#FFE512',
  yellowLight: '#FFF7CC',
  bg: '#FFFBF0',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textSecondary: '#666666',
  textMuted: '#999999',
  border: '#F0E8D8',
  green: '#52c41a',
  red: '#ff4d4f',
} as const;

function SidePanel(): JSX.Element {
  const [stats, setStats] = useState<PopupStats>({ running: false, processedMessages: 0, todayOrders: 0 });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'home' | 'messages'>('home');
  const [loginWarning, setLoginWarning] = useState(false);

  const loadData = useCallback(async () => {
    const [s, cfg] = await Promise.all([getStats(), getSettings()]);
    setStats({ running: s.running, processedMessages: s.processedMessages, todayOrders: s.todayOrders });
    setSettings(cfg);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const handler = () => { void loadData(); };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [loadData]);

  async function checkGoofishLogin(): Promise<boolean> {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CHECK_LOGIN' }) as { loggedIn?: boolean } | undefined;
      return resp?.loggedIn === true;
    } catch (err) {
      console.error('[SidePanel] 登录检查失败:', err);
      return false;
    }
  }

  async function toggleRunning(): Promise<void> {
    const newRunning = !stats.running;
    if (newRunning) {
      const loggedIn = await checkGoofishLogin();
      if (!loggedIn) {
        setLoginWarning(true);
        return;
      }
    }

    setLoginWarning(false);
    const nextStats = await patchStats({ running: newRunning });
    setStats((prev) => ({ ...prev, running: nextStats.running }));
  }

  function goToLogin(): void {
    chrome.tabs.create({ url: 'https://www.goofish.com' });
    setLoginWarning(false);
  }

  if (loading) {
    return <div style={s.loadingWrap}><div style={s.loadingText}>加载中...</div></div>;
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.logo}>🐟</span>
          <span style={s.headerTitle}>闲鱼智能客服</span>
        </div>
        <button style={s.headerBtn} onClick={() => chrome.runtime.openOptionsPage()} title="设置">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1A1A1A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <div style={{ ...s.statusBanner, background: stats.running ? BRAND.yellow : '#f0f0f0' }}>
        <div style={s.statusLeft}>
          <span style={{ ...s.statusDot, background: stats.running ? BRAND.green : BRAND.textMuted }} />
          <span style={{ ...s.statusLabel, color: stats.running ? BRAND.text : BRAND.textMuted }}>
            {stats.running ? '运行中' : '已暂停'}
          </span>
        </div>
        <button
          onClick={toggleRunning}
          style={{ ...s.statusToggle, background: stats.running ? 'rgba(0,0,0,0.1)' : BRAND.yellow }}
        >
          {stats.running ? '暂停' : '启动'}
        </button>
      </div>

      {loginWarning && (
        <div style={s.loginWarning}>
          <div style={s.loginWarningText}>请先登录闲鱼账号，才能启动智能客服</div>
          <div style={s.loginWarningBtns}>
            <button style={s.loginWarningBtn} onClick={goToLogin}>前往登录</button>
            <button style={s.loginWarningCancel} onClick={() => setLoginWarning(false)}>取消</button>
          </div>
        </div>
      )}

      <div style={s.tabBar}>
        {(['home', 'messages'] as const).map((tab) => (
          <button
            key={tab}
            style={{ ...s.tab, ...(activeTab === tab ? s.tabActive : {}) }}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'home' ? '概览' : '消息'}
          </button>
        ))}
      </div>

      <div style={s.content}>
        {activeTab === 'home' && <HomeTab stats={stats} settings={settings} />}
        {activeTab === 'messages' && <MessagesTab />}
      </div>
    </div>
  );
}

function HomeTab({ stats, settings }: { stats: PopupStats; settings: AppSettings | null }): JSX.Element {
  return (
    <>
      <div style={s.statsGrid}>
        <div style={s.statCard}>
          <div style={s.statValue}>{stats.processedMessages}</div>
          <div style={s.statLabel}>已处理消息</div>
        </div>
        <div style={s.statCard}>
          <div style={s.statValue}>{stats.todayOrders}</div>
          <div style={s.statLabel}>今日订单</div>
        </div>
      </div>

      <div style={s.card}>
        <div style={s.cardTitle}>功能状态</div>
        <FeatureRow icon="🤖" label="AI 自动直发" enabled={stats.running && Boolean(settings?.ai.directSendAuthorized)} />
        <FeatureRow icon="🔔" label="下单桌面通知" enabled={settings?.notification.browserEnabled ?? false} />
        <FeatureRow icon="💬" label="下单钉钉通知" enabled={settings?.notification.dingtalkEnabled ?? false} />
        <FeatureRow icon="📨" label="下单飞书通知" enabled={settings?.notification.feishuEnabled ?? false} />
        <FeatureRow icon="✈️" label="下单 Telegram 通知" enabled={settings?.notification.telegramEnabled ?? false} />
      </div>

      <div style={s.card}>
        <div style={s.cardTitle}>AI 配置</div>
        <InfoRow label="服务商" value={settings?.ai.provider ?? '-'} />
        <InfoRow label="模型" value={settings?.ai.model ?? '-'} />
        <InfoRow label="API Key" value={settings?.ai.apiKey ? '已配置' : '未配置'} highlight={!settings?.ai.apiKey} />
        <InfoRow label="自动直发授权" value={settings?.ai.directSendAuthorized ? '已授权' : '未授权'} highlight={!settings?.ai.directSendAuthorized} />
      </div>
    </>
  );
}

function MessagesTab(): JSX.Element {
  const [logs, setLogs] = useState<MessageLogEntry[]>([]);

  useEffect(() => {
    getMessageLogs().then(setLogs);
    const handler = () => { getMessageLogs().then(setLogs); };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, []);

  if (logs.length === 0) {
    return (
      <div style={s.card}>
        <div style={s.cardTitle}>最近消息</div>
        <div style={s.emptyState}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>💬</div>
          <div style={{ color: BRAND.textMuted, fontSize: '13px' }}>
            消息将在收到买家咨询后显示
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={s.cardTitle}>最近消息</div>
      {logs.slice(-20).reverse().map((log) => (
        <div key={log.id} style={s.msgCard}>
          <div style={s.msgHeader}>
            <span style={s.msgBuyer}>{log.buyerName}</span>
            <span style={s.msgTime}>
              {new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div style={s.msgContent}>{log.content}</div>
          {log.reply && (
            <div style={s.msgReply}>
              <span style={s.msgReplyLabel}>AI:</span> {log.reply.slice(0, 100)}
              {log.reply.length > 100 ? '...' : ''}
            </div>
          )}
          <div style={s.msgFooter}>
            <span style={s.msgIntent}>
              {log.intent === 'price' ? '砍价' : log.intent === 'tech' ? '咨询' : log.intent === 'no_reply' ? '无需回复' : '通用'}
              {log.sent ? '' : ' (未发送)'}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function FeatureRow({ icon, label, enabled }: { icon: string; label: string; enabled: boolean }): JSX.Element {
  return (
    <div style={s.featureRow}>
      <span>{icon} {label}</span>
      <span style={{ ...s.badge, background: enabled ? '#e6f7e6' : '#f5f5f5', color: enabled ? BRAND.green : BRAND.textMuted }}>
        {enabled ? '开' : '关'}
      </span>
    </div>
  );
}

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): JSX.Element {
  return (
    <div style={s.infoRow}>
      <span style={{ color: BRAND.textSecondary }}>{label}</span>
      <span style={{ color: highlight ? BRAND.red : BRAND.text, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    background: BRAND.bg,
  },
  loadingWrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: BRAND.bg,
  },
  loadingText: { color: BRAND.textMuted, fontSize: '14px' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 16px',
    background: BRAND.yellow,
    borderBottom: '1px solid rgba(0,0,0,0.06)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  logo: { fontSize: '22px' },
  headerTitle: {
    fontSize: '16px',
    fontWeight: 700,
    color: BRAND.text,
  },
  headerBtn: {
    background: 'rgba(0,0,0,0.06)',
    border: 'none',
    borderRadius: '8px',
    width: '32px',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  statusBanner: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    transition: 'background 0.2s',
  },
  statusLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
  },
  statusLabel: {
    fontSize: '13px',
    fontWeight: 600,
  },
  statusToggle: {
    border: 'none',
    borderRadius: '14px',
    padding: '4px 14px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    color: BRAND.text,
  },
  loginWarning: {
    background: '#fff3f3',
    border: '1px solid #ffccc7',
    borderRadius: '8px',
    margin: '8px 12px 0',
    padding: '12px',
  },
  loginWarningText: {
    fontSize: '13px',
    color: '#cf1322',
    fontWeight: 600,
    marginBottom: '10px',
  },
  loginWarningBtns: {
    display: 'flex',
    gap: '8px',
  },
  loginWarningBtn: {
    flex: 1,
    padding: '8px 0',
    borderRadius: '8px',
    border: 'none',
    background: '#ff4d4f',
    color: '#fff',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  loginWarningCancel: {
    padding: '8px 16px',
    borderRadius: '8px',
    border: '1px solid #d9d9d9',
    background: '#fff',
    color: '#666',
    fontSize: '13px',
    cursor: 'pointer',
  },
  tabBar: {
    display: 'flex',
    borderBottom: `1px solid ${BRAND.border}`,
    background: BRAND.card,
    padding: '0 8px',
  },
  tab: {
    flex: 1,
    padding: '10px 0',
    border: 'none',
    background: 'none',
    fontSize: '13px',
    fontWeight: 500,
    color: BRAND.textMuted,
    cursor: 'pointer',
    borderBottom: '2px solid transparent',
    transition: 'all 0.2s',
  },
  tabActive: {
    color: BRAND.text,
    borderBottomColor: BRAND.yellow,
    fontWeight: 700,
  },
  content: {
    flex: 1,
    padding: '12px',
    overflowY: 'auto',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '10px',
    marginBottom: '12px',
  },
  statCard: {
    background: BRAND.card,
    borderRadius: '12px',
    padding: '16px',
    textAlign: 'center',
    border: `1px solid ${BRAND.border}`,
  },
  statValue: {
    fontSize: '28px',
    fontWeight: 700,
    color: '#E6A700',
  },
  statLabel: {
    fontSize: '12px',
    color: BRAND.textMuted,
    marginTop: '4px',
  },
  card: {
    background: BRAND.card,
    borderRadius: '12px',
    padding: '14px',
    marginBottom: '12px',
    border: `1px solid ${BRAND.border}`,
  },
  cardTitle: {
    fontSize: '13px',
    fontWeight: 700,
    color: BRAND.text,
    marginBottom: '10px',
    paddingBottom: '8px',
    borderBottom: `1px solid ${BRAND.border}`,
  },
  featureRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    fontSize: '13px',
    color: BRAND.text,
    borderBottom: `1px solid ${BRAND.border}`,
  },
  badge: {
    fontSize: '11px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: '10px',
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    fontSize: '13px',
    borderBottom: `1px solid ${BRAND.border}`,
  },
  emptyState: {
    textAlign: 'center',
    padding: '32px 0',
  },
  msgCard: {
    background: BRAND.card,
    borderRadius: '10px',
    padding: '12px',
    marginBottom: '8px',
    border: `1px solid ${BRAND.border}`,
  },
  msgHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '6px',
  },
  msgBuyer: {
    fontSize: '13px',
    fontWeight: 700,
    color: BRAND.text,
  },
  msgTime: {
    fontSize: '11px',
    color: BRAND.textMuted,
  },
  msgContent: {
    fontSize: '13px',
    color: BRAND.text,
    padding: '6px 0',
    borderBottom: `1px solid ${BRAND.border}`,
  },
  msgReply: {
    fontSize: '12px',
    color: BRAND.textSecondary,
    padding: '6px 0',
    lineHeight: '1.5',
  },
  msgReplyLabel: {
    color: '#E6A700',
    fontWeight: 700,
  },
  msgFooter: {
    display: 'flex',
    justifyContent: 'flex-start',
    alignItems: 'center',
    marginTop: '6px',
  },
  msgIntent: {
    fontSize: '11px',
    color: BRAND.textMuted,
    background: BRAND.yellowLight,
    padding: '2px 8px',
    borderRadius: '8px',
    fontWeight: 500,
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>
);

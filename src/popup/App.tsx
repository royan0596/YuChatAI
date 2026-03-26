import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { getStats, patchStats, type StoredStats } from '../shared/storage';
import type { PopupStats } from '../shared/types';

function Popup(): JSX.Element {
  const [stats, setStats] = useState<PopupStats>({
    running: true,
    processedMessages: 0,
    todayOrders: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats(): Promise<void> {
    const s = await getStats();
    setStats({
      running: s.running,
      processedMessages: s.processedMessages,
      todayOrders: s.todayOrders,
    });
    setLoading(false);
  }

  async function toggleRunning(): Promise<void> {
    const next = await patchStats({ running: !stats.running });
    setStats((prev) => ({ ...prev, running: next.running }));
  }

  function openOptions(): void {
    chrome.runtime.openOptionsPage();
  }

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>加载中...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* 头部 */}
      <div style={styles.header}>
        <div style={styles.title}>🐟 闲鱼智能客服</div>
        <button style={styles.settingsBtn} onClick={openOptions}>
          ⚙️
        </button>
      </div>

      {/* 状态卡片 */}
      <div style={styles.statusCard}>
        <div style={styles.statusRow}>
          <span
            style={{
              ...styles.statusDot,
              background: stats.running ? '#52c41a' : '#999',
            }}
          />
          <span style={styles.statusText}>
            {stats.running ? '运行中' : '已暂停'}
          </span>
        </div>
        <div style={styles.statsRow}>
          <div style={styles.statItem}>
            <div style={styles.statValue}>{stats.processedMessages}</div>
            <div style={styles.statLabel}>已处理消息</div>
          </div>
          <div style={styles.statItem}>
            <div style={styles.statValue}>{stats.todayOrders}</div>
            <div style={styles.statLabel}>今日订单</div>
          </div>
        </div>
      </div>

      {/* 功能开关 */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>功能开关</div>
        <div style={styles.switchList}>
          <SwitchItem label="🤖 AI 自动回复" enabled={stats.running} />
          <SwitchItem label="📢 订单通知" enabled={stats.running} />
        </div>
      </div>

      {/* 最近消息 */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>最近消息</div>
        <div style={styles.messageList}>
          <div style={styles.messageItem}>
            <div style={styles.messageBuyer}>👤 买家A</div>
            <div style={styles.messageContent}>还能便宜吗？</div>
            <div style={styles.messageStatus}>🤖 已回复</div>
          </div>
          <div style={styles.messageDivider} />
          <div style={styles.messageItem}>
            <div style={styles.messageBuyer}>👤 买家B</div>
            <div style={styles.messageContent}>什么时候发货</div>
            <div style={styles.messageStatus}>⏳ 等待 AI...</div>
          </div>
        </div>
      </div>

      {/* 底部操作 */}
      <div style={styles.footer}>
        <button style={styles.footerBtn} onClick={toggleRunning}>
          {stats.running ? '⏸️ 暂停' : '▶️ 启动'}
        </button>
        <button style={styles.footerBtn} onClick={openOptions}>
          📊 详细设置
        </button>
      </div>
    </div>
  );
}

function SwitchItem({
  label,
  enabled,
}: {
  label: string;
  enabled: boolean;
}): JSX.Element {
  return (
    <div style={styles.switchItem}>
      <span>{label}</span>
      <span style={{ color: enabled ? '#52c41a' : '#999' }}>
        {enabled ? '开 ●' : '关 ○'}
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '380px',
    minHeight: '500px',
    padding: '16px',
    background: '#f5f5f5',
  },
  loading: {
    textAlign: 'center',
    padding: '40px',
    color: '#999',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  title: {
    fontSize: '18px',
    fontWeight: 600,
    color: '#333',
  },
  settingsBtn: {
    background: 'none',
    border: 'none',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '4px',
  },
  statusCard: {
    background: '#fff',
    borderRadius: '12px',
    padding: '16px',
    marginBottom: '16px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '12px',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  },
  statusText: {
    fontSize: '14px',
    color: '#666',
  },
  statsRow: {
    display: 'flex',
    gap: '24px',
  },
  statItem: {
    flex: 1,
    textAlign: 'center',
  },
  statValue: {
    fontSize: '24px',
    fontWeight: 600,
    color: '#ff6b00',
  },
  statLabel: {
    fontSize: '12px',
    color: '#999',
    marginTop: '4px',
  },
  section: {
    background: '#fff',
    borderRadius: '12px',
    padding: '16px',
    marginBottom: '16px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
  },
  sectionTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#333',
    marginBottom: '12px',
  },
  switchList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  switchItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: '14px',
    color: '#333',
  },
  messageList: {
    display: 'flex',
    flexDirection: 'column',
  },
  messageItem: {
    padding: '8px 0',
  },
  messageBuyer: {
    fontSize: '13px',
    color: '#666',
    marginBottom: '4px',
  },
  messageContent: {
    fontSize: '14px',
    color: '#333',
    marginBottom: '4px',
  },
  messageStatus: {
    fontSize: '12px',
    color: '#999',
  },
  messageDivider: {
    height: '1px',
    background: '#eee',
    margin: '4px 0',
  },
  footer: {
    display: 'flex',
    gap: '12px',
  },
  footerBtn: {
    flex: 1,
    padding: '12px',
    borderRadius: '8px',
    border: 'none',
    background: '#ff6b00',
    color: '#fff',
    fontSize: '14px',
    cursor: 'pointer',
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>
);

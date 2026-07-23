import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Terminal,
  Key,
  Play,
  Pause,
  Power,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  FileText,
  Settings,
  Server,
  Database,
  Menu,
  X,
  Sparkles,
  Activity,
  User,
  Cpu,
  Plus,
  Trash2,
  Shield,
  Copy,
  ExternalLink,
} from 'lucide-react';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [healthData, setHealthData] = useState(null);
  const [modelsData, setModelsData] = useState([]);
  const [tokenProfile, setTokenProfile] = useState('extreme');
  const [logs, setLogs] = useState([]);
  const [isServerRunning, setIsServerRunning] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [notification, setNotification] = useState(null);

  const logEndRef = useRef(null);

  const showNotify = (type, message) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  const addLog = useCallback((level, message) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-499), { id: Date.now() + Math.random(), timestamp, level, message }]);
  }, []);

  // Fetch status & health from local REST API
  const fetchStatus = useCallback(async () => {
    try {
      const url = `/healthz?_=${Date.now()}`;
      const opts = { cache: 'no-store' };
      let res = await fetch(url, opts);
      if (!res.ok) res = await fetch(`http://127.0.0.1:8765${url}`, opts);
      if (res.ok) {
        const data = await res.json();
        setHealthData(data);
        setIsServerRunning(true);
      } else {
        setIsServerRunning(false);
      }
    } catch {
      setIsServerRunning(false);
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      let res = await fetch('/v1/models', { cache: 'no-store' });
      if (!res.ok) res = await fetch('http://127.0.0.1:8765/v1/models', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setModelsData(data.data || []);
      }
    } catch {
      setModelsData([]);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      let res = await fetch('/v1/logs', { cache: 'no-store' });
      if (!res.ok) res = await fetch('http://127.0.0.1:8765/v1/logs', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.logs)) {
          setLogs(data.logs);
        }
      }
    } catch {
      // Ignore poll errors when offline
    }
  }, []);

  const fetchTokenProfile = useCallback(async () => {
    try {
      let res = await fetch('/v1/settings/token-profile', { cache: 'no-store' });
      if (!res.ok) res = await fetch('http://127.0.0.1:8765/v1/settings/token-profile', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.profile === 'safe' || data.profile === 'extreme') {
          setTokenProfile(data.profile);
        }
      }
    } catch {
      // Ignore
    }
  }, []);

  const saveTokenProfile = async (profile) => {
    setIsActionLoading(true);
    try {
      let res = await fetch('/v1/settings/token-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) {
        res = await fetch('http://127.0.0.1:8765/v1/settings/token-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile }),
        });
      }
      if (res.ok) {
        setTokenProfile(profile);
        showNotify('success', `Token profile set to ${profile === 'safe' ? 'Safe' : 'Extreme'}. Reload Codex to apply.`);
        addLog('info', `Token profile updated to: ${profile}`);
      } else {
        const err = await res.json().catch(() => ({}));
        showNotify('error', 'Failed to save token profile: ' + (err.error || res.status));
      }
    } catch (err) {
      showNotify('error', 'Failed to save token profile: ' + err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchModels();
    fetchTokenProfile();
    if (activeTab === 'logs') {
      fetchLogs();
    }
    const interval = setInterval(() => {
      fetchStatus();
      if (activeTab === 'logs') {
        fetchLogs();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchModels, fetchLogs, fetchTokenProfile, activeTab]);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Server management actions via REST or trigger
  const handleServerToggle = async () => {
    setIsActionLoading(true);
    try {
      if (isServerRunning) {
        showNotify('info', 'Pausing bridge server services...');
        let res;
        try {
          res = await fetch('/v1/server/stop', { method: 'POST', cache: 'no-store' });
        } catch {
          res = await fetch('http://127.0.0.1:8765/v1/server/stop', { method: 'POST', cache: 'no-store' });
        }
        if (res.ok) {
          showNotify('success', 'Bridge server paused');
          addLog('info', 'Bridge server paused from dashboard');
        }
      } else {
        showNotify('info', 'Resuming bridge server services...');
        let res;
        try {
          res = await fetch('/v1/server/start', { method: 'POST', cache: 'no-store' });
        } catch {
          res = await fetch('http://127.0.0.1:8765/v1/server/start', { method: 'POST', cache: 'no-store' });
        }
        if (res.ok) {
          showNotify('success', 'Bridge server resumed');
          addLog('info', 'Bridge server resumed from dashboard');
        }
      }
      await fetchStatus();
    } catch (err) {
      showNotify('error', 'Failed to toggle server: ' + err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleKillServer = async () => {
    if (!window.confirm('Are you sure you want to completely kill the server process? This will terminate the running Node launcher.')) {
      return;
    }
    setIsActionLoading(true);
    showNotify('info', 'Killing server process...');
    addLog('warning', 'Kill server process requested from dashboard');
    try {
      let res;
      try {
        res = await fetch('/v1/server/kill', { method: 'POST', cache: 'no-store' });
      } catch {
        res = await fetch('http://127.0.0.1:8765/v1/server/kill', { method: 'POST', cache: 'no-store' });
      }
      if (res.ok) {
        setIsServerRunning(false);
        setHealthData(null);
        showNotify('error', 'Server process killed.');
      }
    } catch {
      setIsServerRunning(false);
      setHealthData(null);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleAddAccountSubmit = async (e) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setIsActionLoading(true);
    addLog('info', 'Adding new Notion token_v2 account...');
    try {
      const request = () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim() }),
      });
      let res;
      try {
        res = await fetch('/v1/accounts', request());
      } catch {
        res = await fetch('http://127.0.0.1:8765/v1/accounts', { ...request() });
      }
      if (res.ok) {
        const data = await res.json();
        const created = Number(data.created_count || 0);
        const skipped = Number(data.skipped_count || 0);
        let message = "";
        if (created > 0) {
          const names = (data.created_workspaces || [])
            .map((w) => w.workspace_name || w.workspace_domain || 'Workspace')
            .join(', ');
          message = `Added ${created} workspace${created === 1 ? '' : 's'} (${names})${skipped > 0 ? `; ${skipped} already configured` : ''}`;
        } else {
          message = `All ${skipped} workspace${skipped === 1 ? ' was' : 's were'} already configured`;
        }
        showNotify('success', message);
        addLog('info', message);
        setShowAddForm(false);
        setTokenInput('');
        await fetchStatus();
      } else {
        const err = await res.json().catch(() => ({}));
        showNotify('error', 'Failed to add account: ' + (err.error || res.statusText || res.status));
        addLog('error', 'Failed to add account: ' + (err.error || res.statusText));
      }
    } catch (err) {
      showNotify('error', 'Failed to add account: ' + err.message);
      addLog('error', err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDeleteAccount = async (acc) => {
    const accountId = typeof acc === 'object'
      ? (acc.id || acc.workspace_id || (acc.accountPath ? acc.accountPath.split(/[\/\\]/).pop() : null))
      : acc;
    if (!accountId) {
      showNotify('error', 'Unable to resolve account ID for deletion.');
      return;
    }
    setDeletingId(accountId);
    addLog('info', `Deleting account: ${accountId}`);

    // Optimistically remove from state immediately
    setHealthData((prev) => {
      if (!prev?.account_pool?.accounts) return prev;
      const remaining = prev.account_pool.accounts.filter((a) => {
        const pathLeaf = a.accountPath ? a.accountPath.split(/[\/\\]/).pop() : '';
        return a.id !== accountId && a.workspace_id !== accountId && a.accountPath !== accountId && pathLeaf !== accountId;
      });
      return {
        ...prev,
        account_pool: {
          ...prev.account_pool,
          configured: remaining.length,
          available: remaining.filter((a) => a.available).length,
          accounts: remaining,
        },
      };
    });

    try {
      let res;
      try {
        res = await fetch(`/v1/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE', cache: 'no-store' });
      } catch {
        res = await fetch(`http://127.0.0.1:8765/v1/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE', cache: 'no-store' });
      }
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        showNotify('success', 'Account removed successfully.');
        addLog('info', `Account removed: ${accountId}`);
        if (data.account_pool) {
          setHealthData((prev) => (prev ? { ...prev, account_pool: data.account_pool } : prev));
        }
        await fetchStatus();
      } else {
        const err = await res.json().catch(() => ({}));
        const errMsg = err.error || res.statusText || String(res.status);
        showNotify('error', 'Failed to remove account: ' + errMsg);
        addLog('error', 'Failed to remove account: ' + errMsg);
        await fetchStatus();
      }
    } catch (err) {
      showNotify('error', 'Failed to remove account: ' + err.message);
      addLog('error', err.message);
      await fetchStatus();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex h-screen bg-[#0a0a0f] text-gray-100 font-sans overflow-hidden">
      {/* Sidebar */}
      <div className={`${sidebarOpen ? 'w-64' : 'w-20'} transition-all duration-300 bg-[#12121a] border-r border-[#2a2a3a] flex flex-col relative`}>
        <div className="p-4 border-b border-[#2a2a3a] flex items-center justify-between min-h-[73px]">
          {sidebarOpen ? (
            <>
              <div className="flex items-center gap-3 overflow-hidden">
                <div className="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center shadow-lg shadow-purple-500/20 border border-purple-400/30">
                  <Sparkles size={20} className="text-white" />
                </div>
                <div className="truncate">
                  <div className="font-bold text-sm text-white tracking-wide truncate">NotionCode MCP</div>
                  <div className="text-[10px] text-purple-400 font-mono tracking-wider">CONTROL DASHBOARD</div>
                </div>
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="text-gray-400 hover:text-white transition-colors p-1.5 rounded-xl hover:bg-[#1e1e2e] shrink-0 ml-1"
                title="Collapse Sidebar"
              >
                <X size={18} />
              </button>
            </>
          ) : (
            <div className="w-full flex justify-center">
              <button
                onClick={() => setSidebarOpen(true)}
                className="text-gray-400 hover:text-white transition-all p-2 rounded-xl hover:bg-[#1e1e2e] flex items-center justify-center"
                title="Expand Sidebar"
              >
                <Menu size={20} />
              </button>
            </div>
          )}
        </div>

        <nav className="flex-1 p-3 space-y-2 overflow-y-auto">
          {[
            { id: 'dashboard', label: 'Dashboard', icon: Activity },
            { id: 'accounts', label: 'Accounts Pool', icon: User },
            { id: 'models', label: 'Models & Routing', icon: Cpu },
            { id: 'logs', label: 'Server Logs', icon: Terminal },
            { id: 'settings', label: 'Token Settings', icon: Settings },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              title={!sidebarOpen ? item.label : undefined}
              className={`w-full flex items-center gap-3.5 px-3.5 py-3 rounded-xl transition-all text-sm font-medium focus:outline-none focus:ring-0 select-none outline-none ${
                activeTab === item.id
                  ? 'bg-gradient-to-r from-purple-600/30 to-blue-600/20 text-purple-300 border border-purple-500/30 shadow-md shadow-purple-900/20'
                  : 'text-gray-400 hover:text-gray-100 hover:bg-[#1a1a26] border border-transparent'
              } ${!sidebarOpen ? 'justify-center px-0' : ''}`}
            >
              <item.icon size={20} className="shrink-0" />
              {sidebarOpen && <span className="truncate">{item.label}</span>}
            </button>
          ))}
        </nav>

        <div className="p-3 border-t border-[#2a2a3a] bg-[#0d0d14]">
          <div className={`flex items-center gap-3 px-2 py-1.5 ${!sidebarOpen ? 'justify-center' : ''}`} title={!sidebarOpen ? (isServerRunning ? 'Server Active (:8765)' : 'Server Offline') : undefined}>
            <span className={`w-3 h-3 rounded-full shrink-0 ${isServerRunning ? 'bg-emerald-400 shadow-lg shadow-emerald-500/50 animate-pulse' : 'bg-rose-500'}`} />
            {sidebarOpen && (
              <span className="text-xs font-semibold text-gray-300 truncate">
                {isServerRunning ? 'Server Active (:8765)' : 'Server Offline'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-[#2a2a3a] bg-[#0f0f18]/80 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-white tracking-tight">
              {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
            </h1>
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#1a1a26] border border-[#2a2a3a] text-xs font-mono text-gray-300">
              <span className={`w-2 h-2 rounded-full ${isServerRunning ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              {isServerRunning ? '127.0.0.1:8765' : 'Stopped'}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {notification && (
              <div className={`px-3 py-1.5 rounded-lg text-xs font-medium fade-in ${
                notification.type === 'error' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
              }`}>
                {notification.message}
              </div>
            )}
            <button
              onClick={handleServerToggle}
              disabled={isActionLoading}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                isServerRunning
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30'
                  : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30'
              }`}
            >
              {isServerRunning ? <Pause size={14} /> : <Play size={14} />}
              {isServerRunning ? 'Pause Server' : 'Resume Server'}
            </button>
            <button
              onClick={handleKillServer}
              disabled={isActionLoading}
              title="Kill entire Node server process"
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30 hover:bg-rose-500/30 transition-all cursor-pointer"
            >
              <Power size={14} />
              Kill Server
            </button>
            <button
              onClick={() => { fetchStatus(); fetchModels(); }}
              className="p-2 rounded-xl bg-[#1a1a26] hover:bg-[#252536] text-gray-400 hover:text-white border border-[#2a2a3a] transition-all"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              {/* Stat Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
                {[
                  { label: 'Bridge Server', value: isServerRunning ? 'Active' : 'Offline', icon: Server, color: isServerRunning ? 'text-emerald-400' : 'text-rose-400', badge: 'PORT 8765' },
                  { label: 'Notion Accounts', value: healthData?.account_pool?.configured ?? (isServerRunning ? '...' : '0'), icon: User, color: 'text-purple-400', badge: `${healthData?.account_pool?.available || 0} READY` },
                  { label: 'Max Account Pool', value: '25 Accounts', icon: Shield, color: 'text-blue-400', badge: 'ROUND-ROBIN' },
                  { label: 'Default Model', value: 'GPT-5.6 Sol', icon: Cpu, color: 'text-amber-400', badge: 'PRIMARY' },
                ].map((stat, i) => (
                  <div key={i} className="bg-[#12121a] border border-[#2a2a3a] rounded-2xl p-4 md:p-5 shadow-sm hover:border-[#3a3a4a] hover:scale-[1.01] transition-all">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-400 truncate">{stat.label}</span>
                      <stat.icon size={18} className={`${stat.color} shrink-0 ml-1`} />
                    </div>
                    <div className="flex items-baseline justify-between mt-3 flex-wrap gap-1">
                      <div className="text-xl md:text-2xl font-bold text-white tracking-tight truncate">{stat.value}</div>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-[#1c1c2b] text-gray-300 border border-[#2a2a3a] font-semibold shrink-0">{stat.badge}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Endpoint & Pool Details */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-[#12121a] border border-[#2a2a3a] rounded-2xl p-6 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-[#2a2a3a] pb-4">
                    <div>
                      <h3 className="text-base font-semibold text-white flex items-center gap-2">
                        <Activity size={18} className="text-purple-400" /> API Endpoint Status
                      </h3>
                      <p className="text-xs text-gray-400 mt-0.5">Live status of the unified Node bridge and MCP runtime proxy endpoints.</p>
                    </div>
                    <span className="text-xs text-emerald-400 font-mono font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30">ONLINE</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-xs pt-1">
                    <div className="bg-[#181824] p-4 rounded-xl border border-[#262636] flex flex-col justify-between space-y-2">
                      <span className="text-gray-400 font-sans text-xs font-medium">HTTP Bridge</span>
                      <span className="text-purple-300 font-semibold truncate">http://127.0.0.1:8765</span>
                    </div>
                    <div className="bg-[#181824] p-4 rounded-xl border border-[#262636] flex flex-col justify-between space-y-2">
                      <span className="text-gray-400 font-sans text-xs font-medium">MCP Runtime</span>
                      <span className="text-blue-300 font-semibold truncate">http://127.0.0.1:8787</span>
                    </div>
                    <div className="bg-[#181824] p-4 rounded-xl border border-[#262636] flex flex-col justify-between space-y-2">
                      <span className="text-gray-400 font-sans text-xs font-medium">Health Check</span>
                      <span className="text-emerald-300 font-semibold truncate">/healthz</span>
                    </div>
                  </div>
                </div>

                <div className="bg-[#12121a] border border-[#2a2a3a] rounded-2xl p-6 space-y-4 flex flex-col justify-between shadow-sm">
                  <div className="flex items-center justify-between border-b border-[#2a2a3a] pb-4">
                    <h3 className="text-base font-semibold text-white flex items-center gap-2">
                      <Shield size={18} className="text-blue-400" /> Live Account Pool
                    </h3>
                    <span className="text-xs text-purple-400 font-mono font-semibold px-2 py-0.5 rounded bg-purple-500/10 border border-purple-500/30">ROTATING</span>
                  </div>
                  <div className="space-y-2.5 text-xs font-mono pt-1">
                    <div className="flex justify-between items-center bg-[#181824] p-3 rounded-xl border border-[#262636]">
                      <span className="text-gray-400 font-sans">Available Accounts:</span>
                      <span className="text-emerald-400 font-bold">{healthData?.account_pool?.available || 0}</span>
                    </div>
                    <div className="flex justify-between items-center bg-[#181824] p-3 rounded-xl border border-[#262636]">
                      <span className="text-gray-400 font-sans">Cooldown Accounts:</span>
                      <span className="text-amber-400 font-bold">{healthData?.account_pool?.cooldown || 0}</span>
                    </div>
                    <div className="flex justify-between items-center bg-[#181824] p-3 rounded-xl border border-[#262636]">
                      <span className="text-gray-400 font-sans">Max Capacity:</span>
                      <span className="text-blue-400 font-bold">25 Slots</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'accounts' && (
            <div className="bg-[#12121a] border border-[#2a2a3a] rounded-2xl p-6 space-y-5 shadow-sm">
              <div className="flex items-center justify-between border-b border-[#2a2a3a] pb-4">
                <div>
                  <h3 className="text-base font-semibold text-white flex items-center gap-2">
                    <User size={18} className="text-purple-400" /> Configured Accounts Pool
                  </h3>
                  <p className="text-xs text-gray-400 mt-0.5">Supports up to 25 unique workspace accounts with automated failover and round-robin load balancing.</p>
                </div>
                <button
                  onClick={() => setShowAddForm((v) => !v)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-lg shadow-purple-600/20 transition-all cursor-pointer"
                >
                  {showAddForm ? <X size={14} /> : <Plus size={14} />}
                  {showAddForm ? 'Cancel' : 'Add Account'}
                </button>
              </div>

              {/* Inline add form */}
              {showAddForm && (
                <form onSubmit={handleAddAccountSubmit} className="bg-[#181824] border border-purple-500/40 rounded-xl p-4 space-y-3.5 fade-in">
                  <div className="text-xs font-semibold text-purple-300 flex items-center gap-2">
                    <Plus size={14} /> Add Notion Account Token
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-300 mb-1">Notion token_v2 value or browser cookie</label>
                    <input
                      type="password"
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                      placeholder="Paste the token_v2 value or cookie..."
                      className="w-full bg-[#0f0f18] border border-[#2a2a3a] rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-purple-500 font-mono transition-colors"
                      required
                      autoFocus
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={() => { setShowAddForm(false); setTokenInput(''); }} className="px-4 py-2 rounded-xl bg-[#1e1e2e] hover:bg-[#28283a] text-gray-300 text-xs font-semibold transition-colors cursor-pointer">Cancel</button>
                    <button type="submit" disabled={isActionLoading} className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-2 shadow-md shadow-purple-600/20 transition-all cursor-pointer">
                      {isActionLoading ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Save Account
                    </button>
                  </div>
                </form>
              )}

              <div className="space-y-3 pt-1">
                {(healthData?.account_pool?.accounts || []).map((acc, index) => (
                  <div key={acc.id || index} className="bg-[#181824] border border-[#262636] rounded-xl p-4 flex items-center justify-between hover:border-[#36364a] transition-all">
                    <div className="flex items-center gap-3.5">
                      <div className="w-9 h-9 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-xs border border-purple-500/30 shrink-0">
                        {index + 1}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                          {acc.workspace_name || acc.workspace_domain || (acc.workspace_id ? `Space (${acc.workspace_id.slice(0, 8)})` : `Workspace ${index + 1}`)}
                          {acc.workspace_id && <span className="text-[10px] font-mono text-gray-400 bg-[#222232] px-2 py-0.5 rounded border border-[#2a2a3a]">ID: {acc.workspace_id}</span>}
                        </div>
                        <div className="text-xs text-gray-400 font-mono mt-1 flex items-center gap-3">
                          <span>User: {acc.user_name || acc.user_email || acc.user_id || 'Configured User'}</span>
                          <span>•</span>
                          <span className="text-gray-500">{acc.accountPath ? acc.accountPath.split(/[\/\\]/).pop() : 'Account Slot'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                        acc.cooldown ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' :
                        acc.disabled ? 'bg-rose-500/20 text-rose-300 border-rose-500/30' :
                        'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                      }`}>
                        {acc.cooldown ? `Cooldown (${acc.retryAfter}s)` : acc.disabled ? 'Disabled' : 'Ready'}
                      </span>
                      <button
                        onClick={() => handleDeleteAccount(acc)}
                        disabled={Boolean(deletingId && [acc.id, acc.workspace_id, acc.accountPath?.split(/[\/\\]/).pop()].includes(deletingId))}
                        title="Remove account"
                        className="p-2 rounded-xl text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/30 transition-all disabled:opacity-40 cursor-pointer"
                      >
                        {deletingId && [acc.id, acc.workspace_id, acc.accountPath?.split(/[\/\\]/).pop()].includes(deletingId) ? (
                          <Loader2 size={14} className="animate-spin text-rose-400" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
                {(!healthData?.account_pool?.accounts || healthData.account_pool.accounts.length === 0) && (
                  <div className="text-center py-10 text-gray-500 text-sm bg-[#181824] rounded-xl border border-[#262636]">
                    No accounts configured in account pool. Click <span className="text-purple-400 font-semibold">Add Account</span> above to connect one.
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'models' && (
            <div className="bg-[#12121a] border border-[#2a2a3a] rounded-2xl p-6 space-y-5 shadow-sm">
              <div className="border-b border-[#2a2a3a] pb-4">
                <h3 className="text-base font-semibold text-white flex items-center gap-2">
                  <Cpu size={18} className="text-amber-400" /> Available Notion AI Models
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">High-reasoning AI models exposed by the compatibility bridge for coding CLI assistants.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-[#181824] border border-purple-500/40 rounded-xl p-4 space-y-2.5 hover:border-purple-500/60 transition-all">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-purple-300">GPT-5.6 Sol (Notion)</span>
                    <span className="px-2.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[10px] font-mono font-semibold">DEFAULT</span>
                  </div>
                  <div className="text-xs text-gray-400 font-mono">ID: gpt-5.6-sol • Internal: orange-mousse</div>
                  <p className="text-xs text-gray-300 pt-1 leading-relaxed">Primary default model across all connected coding assistants (Codex, OpenCode, Claude Code).</p>
                </div>
                <div className="bg-[#181824] border border-[#262636] rounded-xl p-4 space-y-2.5 hover:border-[#36364a] transition-all">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-gray-200">Fable 5 (Notion)</span>
                    <span className="px-2.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[10px] font-mono font-semibold">AVAILABLE</span>
                  </div>
                  <div className="text-xs text-gray-400 font-mono">ID: fable-5 • Internal: acai-budino-high</div>
                  <p className="text-xs text-gray-300 pt-1 leading-relaxed">High-reasoning model available for complex logic tasks.</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="bg-[#12121a] border border-[#2a2a3a] rounded-2xl p-6 flex flex-col h-[540px] shadow-sm">
              <div className="flex items-center justify-between border-b border-[#2a2a3a] pb-4 mb-4">
                <div>
                  <h3 className="text-base font-semibold text-white flex items-center gap-2">
                    <Terminal size={18} className="text-purple-400" /> Live Server Log Stream
                  </h3>
                  <p className="text-xs text-gray-400 mt-0.5">Real-time log buffer streamed from the unified Node server runtime.</p>
                </div>
                <button
                  onClick={() => setLogs([])}
                  className="px-3 py-1.5 rounded-xl bg-[#1a1a26] hover:bg-[#252536] text-xs text-gray-300 hover:text-white border border-[#2a2a3a] font-mono transition-colors cursor-pointer"
                >
                  Clear Logs
                </button>
              </div>
              <div className="flex-1 bg-[#0a0a0f] p-4 rounded-xl font-mono text-xs overflow-y-auto space-y-1.5 border border-[#20202e]">
                {logs.map((log, idx) => (
                  <div key={log.id || idx} className="flex items-start gap-2.5 leading-relaxed">
                    <span className="text-gray-500 whitespace-nowrap text-[11px]">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    <span className={`font-bold text-[11px] ${log.level === 'ERROR' ? 'text-rose-400' : log.level === 'WARNING' ? 'text-amber-400' : 'text-purple-400'}`}>[{log.level}]</span>
                    <span className="text-gray-300 break-all">{log.formatted || log.message}</span>
                  </div>
                ))}
                {logs.length === 0 && <div className="text-gray-600 text-center py-16 font-sans text-xs">Terminal log stream quiet...</div>}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="bg-[#12121a] border border-[#2a2a3a] rounded-2xl p-6 space-y-6 shadow-sm">
              <div className="border-b border-[#2a2a3a] pb-4">
                <h3 className="text-base font-semibold text-white flex items-center gap-2">
                  <Settings size={18} className="text-purple-400" /> Token Profile & Context Window
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">Configure token context limits and automatic history compaction settings.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div
                  onClick={() => setTokenProfile('safe')}
                  className={`p-5 rounded-xl border cursor-pointer transition-all ${tokenProfile === 'safe' ? 'bg-purple-500/10 border-purple-500 shadow-md shadow-purple-900/10' : 'bg-[#181824] border-[#262636] hover:border-[#36364a]'}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-white">Safe Profile</div>
                    {tokenProfile === 'safe' && <CheckCircle2 size={16} className="text-purple-400" />}
                  </div>
                  <div className="text-xs text-gray-400 mt-1 font-mono">100,000 context window • Auto-compact at 60,000</div>
                  <p className="text-xs text-gray-300 mt-2 leading-relaxed">Faster payload transfer and lower memory footprint.</p>
                </div>
                <div
                  onClick={() => setTokenProfile('extreme')}
                  className={`p-5 rounded-xl border cursor-pointer transition-all ${tokenProfile === 'extreme' ? 'bg-purple-500/10 border-purple-500 shadow-md shadow-purple-900/10' : 'bg-[#181824] border-[#262636] hover:border-[#36364a]'}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-white">Extreme Profile (Default)</div>
                    {tokenProfile === 'extreme' && <CheckCircle2 size={16} className="text-purple-400" />}
                  </div>
                  <div className="text-xs text-purple-400 mt-1 font-mono">256,000 context window • Auto-compact at 140,000</div>
                  <p className="text-xs text-gray-300 mt-2 leading-relaxed">Maximum context size for large codebase projects.</p>
                </div>
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-[#2a2a3a]">
                <p className="text-xs text-gray-500">Changes take effect after reloading Codex and opening a new chat.</p>
                <button
                  onClick={() => saveTokenProfile(tokenProfile)}
                  disabled={isActionLoading}
                  className="px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold shadow-lg shadow-purple-600/20 transition-all flex items-center gap-2 cursor-pointer"
                >
                  {isActionLoading ? <Loader2 size={13} className="animate-spin" /> : <Shield size={13} />}
                  Save Profile
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;

const { HCMDiscovery } = require('./hcm-discovery');

let settings = {
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'phi3:mini',
  oracleUrl: '',
  oracleUser: '',
  oraclePass: '',
  alwaysOnTop: true,
};

let hcmDiscovery = null;
let hcmData = null;
let hcmApis = null;
let knowledgeBase = [];
let conversationHistory = [];
let hcmModules = {};
let isCollapsed = false;

async function oracleFetch(resourcePath) {
  if (!settings.oracleUrl || !settings.oracleUser || !settings.oraclePass) {
    throw new Error('Oracle credentials not configured. Set URL, username, and password in Settings.');
  }
  const baseUrl = settings.oracleUrl.replace(/\/+$/, '');
  const url = baseUrl + '/hcmRestApi/resources/11.13.18.05' + resourcePath;
  console.log('[Oracle] Fetching:', url);
  const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
  console.log('[Oracle] Result:', result.ok ? 'OK' : 'FAIL', result.status, result.statusText || '');
  if (!result.ok) {
    const detail = result.body ? ' — ' + result.body.slice(0, 200) : '';
    throw new Error('Oracle API returned ' + result.status + (result.statusText ? ' ' + result.statusText : '') + detail);
  }
  return result.data;
}

async function loadInitialState() {
  settings = await window.savvy.getSettings();
  const kb = await window.savvy.loadKnowledgeBase();
  hcmApis = kb.hcmApis;
  knowledgeBase = kb.knowledgeBase;
  try {
    conversationHistory = JSON.parse(await window.savvy.invoke('get-conversation-history') || '[]');
  } catch { conversationHistory = []; }
  const collapsed = await window.savvy.getUiState('isCollapsed');
  if (collapsed) isCollapsed = true;

  try {
    const tagsResponse = await fetch(settings.ollamaUrl + '/api/tags');
    const { models } = await tagsResponse.json();
    const { checkModelVersion } = require('./model-check');
    const versionCheck = checkModelVersion(models, settings.ollamaModel);
    if (!versionCheck.upToDate) {
      addMessage(versionCheck.message, 'bot');
    }
  } catch (err) {
    console.log('Model version check skipped (Ollama not reachable):', err.message);
  }
}

// Load HCM REST APIs knowledge (uses preloaded hcmApis and loads modules)
async function loadHcmApis() {
  try {
    // Load module index from hcmApis if available
    if (hcmApis && hcmApis.modules) {
      // Module info is already loaded via loadKnowledgeBase
    }
  } catch (err) {
    console.error('Failed to load HCM APIs:', err);
  }
}

// Search HCM APIs based on user query
function searchHcmApis(query) {
  if (!hcmApis) return '';
  const q = query.toLowerCase();
  const matches = [];

  for (const [key, module] of Object.entries(hcmApis.modules || {})) {
    if (module.name.toLowerCase().includes(q) || module.description.toLowerCase().includes(q)) {
      matches.push(`\n### ${module.name} (${module.path})`);
      matches.push(module.description);
      for (const [epKey, ep] of Object.entries(module.endpoints || {})) {
        matches.push(`- ${ep.method} ${ep.path} - ${ep.description}`);
      }
    }
  }

  return matches.length > 0 ? matches.join('\n') : '';
}

// Get module info for a topic
function getModuleInfo(topic) {
  const topicLower = topic.toLowerCase();
  for (const [key, mod] of Object.entries(hcmModules)) {
    if (mod.keywords && mod.keywords.some(kw => topicLower.includes(kw))) {
      return { key, ...mod };
    }
  }
  return null;
}

// ── Knowledge Base ──
function findKnowledge(query) {
  const q = query.toLowerCase();

  // Search through loaded knowledge base
  for (const item of knowledgeBase) {
    if (item.title && item.content) {
      const titleLower = item.title.toLowerCase();
      const contentLower = item.content.toLowerCase();
      if (titleLower.includes(q) || contentLower.includes(q)) {
        return `[${item.title}]\n${item.content}`;
      }
    }
  }

  // Fallback to API reference knowledge
  const apiDocs = [
    { k: ['employee','worker','person'], v: 'GET /hcmRestApi/resources/latest/emps - Workers. Fields: PersonId, DisplayName, FirstName, LastName, EmailAddress, JobName, DepartmentName, LocationName, HireDate, ActionReason, Action.' },
    { k: ['department','org'], v: 'GET /hcmRestApi/resources/latest/departments - Departments. Fields: DepartmentId, Name, Code, BusinessUnitName, ManagerName, LocationName.' },
    { k: ['absence','leave','vacation'], v: 'GET /hcmRestApi/resources/latest/absences - Absence Records. Fields: AbsenceId, AbsenceType, AbsenceStatus, StartDate, EndDate, ApprovalStatus.' },
    { k: ['location','office'], v: 'GET /hcmRestApi/resources/latest/locations - Locations. Fields: LocationId, LocationName, Code, AddressLine1, City, PostalCode, Country.' },
    { k: ['job','position'], v: 'GET /hcmRestApi/resources/latest/jobs - Jobs. Fields: JobId, JobCode, JobName, BusinessUnitName.' },
    { k: ['payroll','salary','pay'], v: 'GET /hcmRestApi/resources/latest/payroll/payments - Payroll payments. GET /hcmRestApi/resources/latest/salaries - Salary records.' },
    { k: ['time','attendance'], v: 'GET /hcmRestApi/resources/latest/timeCards - Time Cards. GET /hcmRestApi/resources/latest/timeEntry - Time Entries.' },
    { k: ['performance','goal'], v: 'GET /hcmRestApi/resources/latest/performanceDocuments - Performance. GET /hcmRestApi/resources/latest/goals - Goals.' },
    { k: ['requisition','hiring'], v: 'GET /hcmRestApi/resources/latest/recruitingRequisitionES - Requisitions. GET /hcmRestApi/resources/latest/candidate - Candidates.' },
    { k: ['benefit'], v: 'GET /hcmRestApi/resources/latest/benefitPlans - Benefits. GET /hcmRestApi/resources/latest/benefitEnrollment - Enrollments.' },
    { k: ['navigate','menu'], v: 'Navigator > My Client Groups: Absences, Time Cards, Payroll, Person Management, Compensation, Documents.' },
    { k: ['policy','compliance'], v: 'EEO: no discrimination. FLSA: minimum wage, overtime. ADA: confidential medical. FMLA: 12 weeks unpaid. I-9: within 3 business days.' },
  ];
  for (const d of apiDocs) {
    if (d.k.some(k => q.includes(k))) return d.v;
  }
  return null;
}

// ── Ollama LLM ──
async function callLLM(messages, onStream) {
  try {
    const resp = await fetch(settings.ollamaUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.ollamaModel, messages, stream: true })
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.model && json.message?.content) {
            fullText += json.message.content;
            if (onStream) onStream(json.message.content);
          }
        } catch {}
      }
    }
    return fullText || 'No response from model.';
  } catch (err) {
    return 'LLM error: ' + err.message;
  }
}

// ── Vision Model Detection ──
async function detectVisionModel() {
  try {
    const resp = await fetch(settings.ollamaUrl + '/api/tags');
    const data = await resp.json();
    const models = data.models || [];
    const visionPatterns = ['llava', 'bakllava', 'qwen-vl', 'qwen2-vl', 'minicpm-v', 'gemma'];
    for (const m of models) {
      for (const p of visionPatterns) {
        if (m.name.toLowerCase().includes(p)) return m.name;
      }
    }
    return null;
  } catch { return null; }
}

// ── Smart HCM Data Fetcher ──
async function autoFetchData(userMessage) {
  const msg = userMessage.toLowerCase();

  if (!settings.oracleUrl || !settings.oracleUser || !settings.oraclePass) {
    return '[ERROR] Oracle Fusion not configured. Set URL, username, and password in Settings.';
  }

  const endpoints = HCM_ENDPOINTS.filter(ep => ep.keywords.some(kw => msg.includes(kw)));

  if (endpoints.length === 0) {
    const ctx = getDiscoveryContext();
    if (ctx) return ctx;
    return '[INFO] No specific data matched. Try asking about employees, absences, departments, jobs, grades, time cards, checklists, etc.';
  }

  const results = [];
  for (const ep of endpoints) {
    try {
      const url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05' + ep.path + ep.params;
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      if (!result.ok) {
        throw new Error('HTTP ' + result.status + ' ' + (result.statusText || '') + (result.body ? ' — ' + result.body.slice(0, 200) : ''));
      }
      const items = result.data?.items || [];
      if (items.length > 0) {
        // Store raw data for LLM context
        results.push(`[ORACLE DATA — ${ep.name}] ${items.length} records found:`);
        items.slice(0, 10).forEach((item, i) => {
          results.push(`  ${i + 1}. ${formatItem(ep.path, item)}`);
        });
        // Also build HTML for chat display
        results.push(`__HTML__${ep.name}__${ep.path}__${items.length}__${JSON.stringify(items)}`);
      } else {
        results.push(`[ORACLE DATA — ${ep.name}] No records found.`);
      }
    } catch (err) {
      const cached = discoveryData[ep.path];
      if (cached && cached.length > 0) {
        results.push(`[ORACLE DATA — ${ep.name}] ${cached.length} cached records (live fetch failed: ${err.message}):`);
        cached.slice(0, 10).forEach((item, i) => {
          results.push(`  ${i + 1}. ${formatItem(ep.path, item)}`);
        });
        results.push(`__HTML__${ep.name}__${ep.path}__${cached.length}__${JSON.stringify(cached)}`);
      } else {
        results.push(`[ERROR — ${ep.name}] ${err.message}`);
      }
    }
  }
  return '\n' + results.join('\n');
}

function formatItem(path, item) {
  const fmt = FORMATTERS[path];
  if (fmt) return fmt(item);
  // Fallback: show key fields only
  const keys = Object.keys(item).filter(k => !k.startsWith('_') && typeof item[k] !== 'object');
  return keys.slice(0, 6).map(k => `${k}: ${item[k]}`).join(' | ');
}

function getDiscoveryContext() {
  const parts = [];
  for (const ep of HCM_ENDPOINTS) {
    const items = discoveryData[ep.path];
    if (items && items.length > 0) {
      parts.push(`[ORACLE DATA — ${ep.name}] ${items.length} records:`);
      items.slice(0, 3).forEach((item, i) => {
        const formatted = formatItem(ep.path, item);
        parts.push(`  ${i + 1}. ${formatted}`);
      });
    }
  }
  return parts.length > 0 ? '\n' + parts.join('\n') : '';
}

const FORMATTERS = {
  '/workers': (w) => {
    const name = w.DisplayName || ((w.FirstName || '') + ' ' + (w.LastName || '')).trim() || 'N/A';
    return `Name: ${name} | Person#: ${w.PersonNumber || 'N/A'} | Dept: ${w.DepartmentName || 'N/A'} | Job: ${w.JobName || w.PositionName || 'N/A'} | Location: ${w.LocationName || 'N/A'} | Status: ${w.EmploymentStatus || w.WorkerType || 'N/A'}`;
  },
  '/absences': (a) => `Type: ${a.AbsenceType || a.AbsenceTypeName || 'N/A'} | From: ${a.StartDate || 'N/A'} | To: ${a.EndDate || 'N/A'} | Days: ${a.AbsenceDays || a.Duration || 'N/A'} | Status: ${a.AbsenceStatus || a.ApprovalStatus || 'N/A'} | Employee: ${a.PersonNumber || 'N/A'}`,
  '/departments': (d) => `Name: ${d.Name || 'N/A'} | Code: ${d.DepartmentCode || 'N/A'} | Manager: ${d.ManagerName || 'N/A'} | Location: ${d.LocationName || 'N/A'}`,
  '/locations': (l) => `Name: ${l.Name || 'N/A'} | Code: ${l.LocationCode || 'N/A'} | City: ${l.City || 'N/A'} | Country: ${l.Country || 'N/A'}`,
  '/jobs': (j) => `Name: ${j.Name || 'N/A'} | Code: ${j.JobCode || 'N/A'} | Family: ${j.JobFamilyName || 'N/A'} | Level: ${j.JobLevel || 'N/A'}`,
  '/positions': (p) => `Name: ${p.Name || 'N/A'} | Code: ${p.PositionCode || 'N/A'} | Dept: ${p.DepartmentName || 'N/A'} | Job: ${p.JobName || 'N/A'}`,
  '/grades': (g) => `Name: ${g.Name || 'N/A'} | Code: ${g.GradeCode || 'N/A'} | Ladder: ${g.GradeLadderName || 'N/A'}`,
  '/timeCards': (t) => `Employee: ${t.EmployeeName || 'N/A'} | Person#: ${t.PersonNumber || 'N/A'} | Start: ${t.DateStart || 'N/A'} | End: ${t.DateEnd || 'N/A'} | Hours: ${t.TotalRegHours || 'N/A'} | Status: ${t.StatusCode || 'N/A'}`,
  '/payrollRelationships': (p) => `Person#: ${p.PersonNumber || 'N/A'} | Name: ${p.EmployeeName || 'N/A'} | Status: ${p.Status || 'N/A'}`,
  '/allocatedChecklists': (c) => `Name: ${c.ChecklistName || 'N/A'} | Person#: ${c.PersonNumber || 'N/A'} | Status: ${c.Status || 'N/A'} | Due: ${c.DueDate || 'N/A'}`,
  '/areasOfResponsibility': (r) => `Type: ${r.ResponsibilityType || 'N/A'} | Person#: ${r.PersonNumber || 'N/A'} | Name: ${r.PersonName || 'N/A'}`,
  '/assignmentStatuses': (s) => `Name: ${s.Name || 'N/A'} | Code: ${s.AssignmentStatusCode || 'N/A'}`,
  '/workerLocations': (l) => `Person#: ${l.PersonNumber || 'N/A'} | Location: ${l.LocationName || 'N/A'}`,
  '/workerPhones': (p) => `Person#: ${p.PersonNumber || 'N/A'} | Type: ${p.PhoneType || 'N/A'} | Number: ${p.PhoneNumber || 'N/A'}`,
  '/workerEmails': (e) => `Person#: ${e.PersonNumber || 'N/A'} | Type: ${e.EmailType || 'N/A'} | Email: ${e.EmailAddress || 'N/A'}`,
  '/workerAddresses': (a) => `Person#: ${a.PersonNumber || 'N/A'} | Type: ${a.AddressType || 'N/A'} | City: ${a.City || 'N/A'} | Country: ${a.Country || 'N/A'}`,
};

// ── Pretty formatters for chat display ──
const FIELD_LABELS = {
  DisplayName: 'Name', FirstName: 'First Name', LastName: 'Last Name', PersonNumber: 'Person #',
  DepartmentName: 'Department', JobName: 'Job', PositionName: 'Position', LocationName: 'Location',
  EmploymentStatus: 'Status', WorkerType: 'Type', HireDate: 'Hire Date',
  AbsenceType: 'Type', AbsenceTypeName: 'Type', StartDate: 'Start', EndDate: 'End',
  AbsenceDays: 'Days', Duration: 'Days', AbsenceStatus: 'Status', ApprovalStatus: 'Status',
  Name: 'Name', Code: 'Code', DepartmentCode: 'Dept Code', ManagerName: 'Manager',
  City: 'City', Country: 'Country', LocationCode: 'Location Code',
  JobCode: 'Job Code', JobFamilyName: 'Family', JobLevel: 'Level',
  PositionCode: 'Position Code', GradeCode: 'Grade Code', GradeLadderName: 'Ladder',
  EmployeeName: 'Employee', DateStart: 'Start', DateEnd: 'End', TotalRegHours: 'Hours',
  StatusCode: 'Status', PhoneNumber: 'Phone', PhoneType: 'Phone Type',
  EmailAddress: 'Email', EmailType: 'Email Type', AddressType: 'Address Type',
  ChecklistName: 'Checklist', DueDate: 'Due Date', ResponsibilityType: 'Type',
  PersonName: 'Person', AssignmentStatusCode: 'Status Code',
  BusinessUnitName: 'Business Unit', HomeCountry: 'Country',
};

function prettifyFieldName(key) {
  return FIELD_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(d) {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    if (isNaN(dt)) return escapeHtml(String(d));
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return escapeHtml(String(d)); }
}

function formatItemAsHTML(path, item, idx) {
  const fmt = HTML_FORMATTERS[path];
  if (fmt) return fmt(item, idx);
  // Fallback: key-value pairs
  const keys = Object.keys(item).filter(k => !k.startsWith('_') && typeof item[k] !== 'object').slice(0, 8);
  return `<div class="data-row"><span class="data-idx">#${idx}</span> ${keys.map(k => `<span class="data-field"><b>${prettifyFieldName(k)}:</b> ${escapeHtml(item[k])}</span>`).join(' &middot; ')}</div>`;
}

const HTML_FORMATTERS = {
  '/workers': (w, idx) => {
    const name = w.DisplayName || ((w.FirstName || '') + ' ' + (w.LastName || '')).trim() || 'N/A';
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(name)}</b></span> <span class="data-field">Dept: ${escapeHtml(w.DepartmentName || '—')}</span> <span class="data-field">Job: ${escapeHtml(w.JobName || w.PositionName || '—')}</span> <span class="data-field">Location: ${escapeHtml(w.LocationName || '—')}</span> <span class="data-tag">${escapeHtml(w.EmploymentStatus || w.WorkerType || '—')}</span></div>`;
  },
  '/absences': (a, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(a.AbsenceType || a.AbsenceTypeName || '—')}</b></span> <span class="data-field">${formatDate(a.StartDate)} – ${formatDate(a.EndDate)}</span> <span class="data-field">${escapeHtml(a.AbsenceDays || a.Duration || '—')} days</span> <span class="data-tag">${escapeHtml(a.AbsenceStatus || a.ApprovalStatus || '—')}</span></div>`;
  },
  '/departments': (d, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(d.Name || '—')}</b></span> <span class="data-field">Code: ${escapeHtml(d.DepartmentCode || '—')}</span> <span class="data-field">Manager: ${escapeHtml(d.ManagerName || '—')}</span> <span class="data-field">Location: ${escapeHtml(d.LocationName || '—')}</span></div>`;
  },
  '/locations': (l, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(l.Name || '—')}</b></span> <span class="data-field">Code: ${escapeHtml(l.LocationCode || '—')}</span> <span class="data-field">City: ${escapeHtml(l.City || '—')}</span> <span class="data-field">Country: ${escapeHtml(l.Country || '—')}</span></div>`;
  },
  '/jobs': (j, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(j.Name || '—')}</b></span> <span class="data-field">Code: ${escapeHtml(j.JobCode || '—')}</span> <span class="data-field">Family: ${escapeHtml(j.JobFamilyName || '—')}</span> <span class="data-field">Level: ${escapeHtml(j.JobLevel || '—')}</span></div>`;
  },
  '/positions': (p, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(p.Name || '—')}</b></span> <span class="data-field">Code: ${escapeHtml(p.PositionCode || '—')}</span> <span class="data-field">Dept: ${escapeHtml(p.DepartmentName || '—')}</span> <span class="data-field">Job: ${escapeHtml(p.JobName || '—')}</span></div>`;
  },
  '/grades': (g, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(g.Name || '—')}</b></span> <span class="data-field">Code: ${escapeHtml(g.GradeCode || '—')}</span> <span class="data-field">Ladder: ${escapeHtml(g.GradeLadderName || '—')}</span></div>`;
  },
  '/timeCards': (t, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(t.EmployeeName || '—')}</b></span> <span class="data-field">${formatDate(t.DateStart)} – ${formatDate(t.DateEnd)}</span> <span class="data-field">${escapeHtml(t.TotalRegHours || '—')} hrs</span> <span class="data-tag">${escapeHtml(t.StatusCode || '—')}</span></div>`;
  },
};

function buildFormattedList(epName, epPath, items, maxShow = 10) {
  const total = items.length;
  const showing = Math.min(total, maxShow);
  let html = `<div class="data-section"><div class="data-header"><span class="data-icon">&#9679;</span> <b>${escapeHtml(epName)}</b> — ${total} record${total !== 1 ? 's' : ''}</div>`;
  for (let i = 0; i < showing; i++) {
    html += formatItemAsHTML(epPath, items[i], i + 1);
  }
  if (total > maxShow) {
    html += `<div class="data-more">${total - maxShow} more records not shown. Ask me to "show all ${epName.toLowerCase()}" to see the full list.</div>`;
  }
  html += '</div>';
  return html;
}

// ── Chat ──
let pageContext = '';

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;

  addMessage(msg, 'user');
  input.value = '';

  const sysPrompt = `You are Savvy, an Oracle Fusion HCM assistant. ONLY answer questions about Oracle Fusion HCM. Never answer questions unrelated to Oracle HCM.

CRITICAL RULES:
1. NEVER fabricate, guess, or make up data. Only show data fetched from the user's Oracle instance.
2. If Oracle credentials are not configured, tell the user to set them in Settings.
3. If an API call fails, show the actual error - never create fake data.
4. Only answer questions about: absences, employees, departments, locations, jobs, payroll, benefits, time cards, performance, learning, checklists.
5. If asked about anything else, respond: "I can only help with Oracle Fusion HCM questions."
6. When showing data, always indicate it comes from their Oracle system.
7. Never include instructions about how to use APIs - just show the data.
8. Be brief and direct. No extra words.
9. Format responses with bullet points, numbered lists, or short paragraphs. No raw JSON.`;

  let fullMsg = msg;

  if (pageContext) {
    fullMsg = '[CURRENT ORACLE PAGE]\n' + pageContext.substring(0, 2000) + '\n\n' + fullMsg;
  }

  // Auto-fetch real data from Oracle HCM based on user intent
  const fetchedData = await autoFetchData(msg);
  let htmlSections = '';
  if (fetchedData) {
    // Extract HTML sections from fetchedData
    const htmlLines = fetchedData.split('\n').filter(l => l.startsWith('__HTML__'));
    for (const line of htmlLines) {
      const parts = line.split('__');
      // __HTML__Name__path__count__json
      const epName = parts[2];
      const epPath = parts[3];
      const count = parseInt(parts[4]);
      try {
        const items = JSON.parse(parts.slice(5).join('__'));
        htmlSections += buildFormattedList(epName, epPath, items);
      } catch {}
    }
    // Strip HTML markers from LLM context
    const llmData = fetchedData.split('\n').filter(l => !l.startsWith('__HTML__')).join('\n');
    fullMsg = llmData + '\n\n' + fullMsg;
  }

  // Search HCM APIs based on user question
  const apiResults = searchHcmApis(msg);
  if (apiResults) {
    fullMsg = '[RELEVANT REST APIS]\n' + apiResults + '\n\n' + fullMsg;
  }

  const summary = hcmDiscovery ? hcmDiscovery.buildSummary() : '';
  const searchResult = hcmDiscovery ? hcmDiscovery.searchContext(msg) : '';
  if (searchResult) {
    fullMsg = '[MATCHING HCM DATA]\n' + searchResult + '\n\n' + fullMsg;
  } else if (summary) {
    fullMsg = '[ORGANIZATION SUMMARY]\n' + summary.substring(0, 3000) + '\n\n' + fullMsg;
  }

  const kb = findKnowledge(msg);
  if (kb) {
    fullMsg = '[HCM KNOWLEDGE]\n' + kb + '\n\n' + fullMsg;
  }

  const messages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: fullMsg }
  ];

  // Show HTML data sections first if available
  const container = document.getElementById('messages');
  if (htmlSections) {
    const dataDiv = document.createElement('div');
    dataDiv.className = 'msg bot';
    dataDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text">${htmlSections}</div>`;
    container.appendChild(dataDiv);
    container.scrollTop = container.scrollHeight;
  }

  const botMsg = addMessage('', 'bot');
  let fullText = '';

  const reply = await callLLM(messages, (chunk) => {
    fullText += chunk;
    botMsg.querySelector('.msg-text').innerHTML = formatMarkdown(fullText);
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  });

  // Save to conversation history
  conversationHistory.push({ role: 'user', content: msg, timestamp: Date.now() });
  conversationHistory.push({ role: 'bot', content: fullText || reply, timestamp: Date.now() });
  try { await window.savvy.invoke('set-conversation-history', JSON.stringify(conversationHistory.slice(-100))); } catch {}
}

// ── Understand (HCM Discovery) ──
let discoveryData = {};
let discoveryInterval = null;

const HCM_ENDPOINTS = [
  { name: 'Workers', path: '/workers', params: '?onlyData=true&limit=20', keywords: ['employee', 'worker', 'person', 'team', 'headcount', 'hire', 'name', 'number'] },
  { name: 'Absences', path: '/absences', params: '?onlyData=true&limit=20', keywords: ['absence', 'leave', 'time off', 'vacation', 'sick'] },
  { name: 'Allocated Checklists', path: '/allocatedChecklists', params: '?onlyData=true&limit=20', keywords: ['checklist', 'task', 'onboarding', 'offboarding'] },
  { name: 'Areas of Responsibility', path: '/areasOfResponsibility', params: '?onlyData=true&limit=20', keywords: ['responsibility', 'representative', 'aor'] },
  { name: 'Assignment Statuses', path: '/assignmentStatuses', params: '?onlyData=true&limit=20', keywords: ['assignment status', 'status type'] },
  { name: 'Departments', path: '/departments', params: '?onlyData=true&limit=20', keywords: ['department', 'dept'] },
  { name: 'Locations', path: '/locations', params: '?onlyData=true&limit=20', keywords: ['location', 'office', 'site', 'address'] },
  { name: 'Jobs', path: '/jobs', params: '?onlyData=true&limit=20', keywords: ['job', 'role', 'position title'] },
  { name: 'Positions', path: '/positions', params: '?onlyData=true&limit=20', keywords: ['position', 'posting'] },
  { name: 'Grades', path: '/grades', params: '?onlyData=true&limit=20', keywords: ['grade', 'level', 'band'] },
  { name: 'Time Cards', path: '/timeCards', params: '?onlyData=true&limit=20', keywords: ['time card', 'timesheet', 'hours', 'clock'] },
  { name: 'Payroll Relationships', path: '/payrollRelationships', params: '?onlyData=true&limit=20', keywords: ['payroll', 'salary', 'pay', 'wage'] },
  { name: 'Worker Locations', path: '/workerLocations', params: '?onlyData=true&limit=20', keywords: ['worker location', 'assignment location'] },
  { name: 'Worker Phones', path: '/workerPhones', params: '?onlyData=true&limit=20', keywords: ['phone', 'telephone', 'mobile'] },
  { name: 'Worker Emails', path: '/workerEmails', params: '?onlyData=true&limit=20', keywords: ['email', 'e-mail', 'mail'] },
  { name: 'Worker Addresses', path: '/workerAddresses', params: '?onlyData=true&limit=20', keywords: ['address', 'home address', 'mailing'] },
];

async function runDiscovery() {
  const btn = document.getElementById('understandBtn');
  const progressDiv = document.getElementById('understand-progress');
  const statusDiv = document.getElementById('understand-status');
  const summaryDiv = document.getElementById('understand-summary');

  if (!settings.oracleUrl || !settings.oracleUser || !settings.oraclePass) {
    statusDiv.style.display = 'block';
    statusDiv.style.background = '#fef2f2';
    statusDiv.style.border = '1px solid #fecaca';
    statusDiv.style.color = '#991b1b';
    statusDiv.textContent = 'Oracle Fusion not configured. Set URL, username, and password in Settings.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Discovering...';
  progressDiv.style.display = 'block';
  progressDiv.innerHTML = '';
  statusDiv.style.display = 'none';
  summaryDiv.style.display = 'none';

  let totalRecords = 0;
  let successCount = 0;
  let failCount = 0;
  const fetchedData = {};

  for (const ep of HCM_ENDPOINTS) {
    const line = document.createElement('div');
    line.style.cssText = 'font-size:11px;color:#64748b;padding:2px 0;';
    line.textContent = `\u25CB ${ep.name}...`;
    progressDiv.appendChild(line);

    try {
      const url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05' + ep.path + ep.params;
      console.log('[Discovery] Fetching:', url);
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      if (!result.ok) {
        throw new Error('HTTP ' + result.status + ' ' + (result.statusText || '') + (result.body ? ' — ' + result.body.slice(0, 150) : ''));
      }
      const items = result.data?.items || [];
      fetchedData[ep.path] = items;
      totalRecords += items.length;
      successCount++;
      line.textContent = `\u2713 ${ep.name}: ${items.length} records`;
      line.style.color = '#166534';
    } catch (err) {
      console.error('[Discovery] Failed:', ep.name, err.message);
      failCount++;
      line.textContent = `\u2717 ${ep.name}: ${err.message}`;
      line.style.color = '#991b1b';
    }
    progressDiv.scrollTop = progressDiv.scrollHeight;
  }

  discoveryData = fetchedData;

  statusDiv.style.display = 'block';
  if (failCount === 0) {
    statusDiv.style.background = '#f0fdf4';
    statusDiv.style.border = '1px solid #bbf7d0';
    statusDiv.style.color = '#166534';
    statusDiv.textContent = `Done! ${successCount}/${HCM_ENDPOINTS.length} endpoints OK, ${totalRecords} total records. Auto-refreshes every 5 min.`;
  } else {
    statusDiv.style.background = '#fffbeb';
    statusDiv.style.border = '1px solid #fde68a';
    statusDiv.style.color = '#92400e';
    statusDiv.textContent = `Partial: ${successCount} OK, ${failCount} failed, ${totalRecords} records. Auto-refreshes every 5 min.`;
  }

  // Start auto-refresh every 5 minutes
  if (discoveryInterval) clearInterval(discoveryInterval);
  discoveryInterval = setInterval(runDiscoverySilent, 5 * 60 * 1000);

  btn.disabled = false;
  btn.textContent = 'Re-Discover Now';
}

async function runDiscoverySilent() {
  if (!settings.oracleUrl || !settings.oracleUser || !settings.oraclePass) return;
  const fetchedData = {};
  for (const ep of HCM_ENDPOINTS) {
    try {
      const url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05' + ep.path + ep.params;
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      if (!result.ok) continue;
      fetchedData[ep.path] = result.data?.items || [];
    } catch {}
  }
  discoveryData = fetchedData;
  console.log('[Discovery] Auto-refreshed', Object.keys(fetchedData).length, 'endpoints');
}

function getDiscoveryContext() {
  const parts = [];
  for (const ep of HCM_ENDPOINTS) {
    const items = discoveryData[ep.path];
    if (items && items.length > 0) {
      parts.push(`[${ep.name} - ${items.length} records]`);
      items.slice(0, 3).forEach((item, i) => {
        parts.push(`  ${i + 1}. ${JSON.stringify(item).slice(0, 300)}`);
      });
    }
  }
  return parts.length > 0 ? parts.join('\n') : '';
}

// ── Read Page (Vision) ──
let selectedWindow = null;
let liveReadInterval = null;
let isLiveReading = false;

async function loadWindows() {
  const list = document.getElementById('window-list');
  const content = document.getElementById('read-content');
  const backBtn = document.getElementById('backToWindows');

  list.style.display = 'block';
  content.style.display = 'none';
  backBtn.style.display = 'none';
  list.innerHTML = '<div style="color:#64748b;font-size:11px;">Loading windows...</div>';

  const sources = await window.savvy.getWindowSources();
  list.innerHTML = '';

  const refreshHtml = '<button class="read-btn" id="refreshWindows" style="margin:0 0 8px 0;width:100%;">Refresh Windows</button>';
  list.innerHTML = '<div class="setting-label" style="margin-bottom:8px;">Select a window to read:</div><div id="windows-container"></div>' + refreshHtml;

  document.getElementById('refreshWindows').addEventListener('click', loadWindows);

  const container = document.getElementById('windows-container');

  sources.forEach(source => {
    const div = document.createElement('div');
    div.className = 'window-item';
    div.style.cssText = 'padding:6px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:6px;cursor:pointer;background:#f8fafc;';
    div.innerHTML = `
      <img src="${source.thumbnail}" alt="${source.name}" style="width:100%;height:80px;object-fit:cover;border-radius:4px;margin-bottom:4px;" />
      <div style="font-size:10px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${source.name}</div>
    `;
    div.addEventListener('mouseenter', () => { div.style.borderColor = '#0070F3'; div.style.background = '#eff6ff'; });
    div.addEventListener('mouseleave', () => { div.style.borderColor = '#e2e8f0'; div.style.background = '#f8fafc'; });
    div.addEventListener('click', () => captureWindow(source, false));
    container.appendChild(div);
  });
}

async function captureWindow(source, isLive = false) {
  const list = document.getElementById('window-list');
  const content = document.getElementById('read-content');
  const backBtn = document.getElementById('backToWindows');
  const readContent = document.getElementById('read-content');
  const readControls = document.getElementById('read-controls');

  list.style.display = 'none';
  content.style.display = 'block';
  backBtn.style.display = 'block';
  readControls.style.display = 'block';
  selectedWindow = source;

  if (!isLive) {
    readContent.innerHTML = '';
  }

  // Create or get status div
  let statusDiv = document.getElementById('read-status');
  if (!statusDiv) {
    statusDiv = document.createElement('div');
    statusDiv.id = 'read-status';
    statusDiv.style.cssText = 'padding:8px;margin-bottom:8px;border-radius:6px;font-size:11px;';
    readContent.insertBefore(statusDiv, readContent.firstChild);
  }

  // Create or get image container
  let imgContainer = document.getElementById('read-img-container');
  if (!imgContainer) {
    imgContainer = document.createElement('div');
    imgContainer.id = 'read-img-container';
    imgContainer.style.cssText = 'margin-bottom:8px;';
    readContent.insertBefore(imgContainer, statusDiv.nextSibling);
  }

  statusDiv.textContent = isLive ? `Updating: ${source.name}...` : `Analyzing: ${source.name}...`;
  statusDiv.style.color = isLive ? '#0070F3' : '#64748b';

  try {
    const dataUrl = await window.savvy.captureWindow(source.id);

    // Update image
    imgContainer.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.cssText = 'width:100%;max-height:200px;object-fit:contain;border-radius:6px;border:1px solid #e2e8f0;';
    imgContainer.appendChild(img);

    const visionModel = await detectVisionModel();

    if (visionModel) {
      const visionPrompt = `Analyze this Oracle Fusion HCM screenshot. List:
1. Page title and module (e.g., "My Team", "Absences", "Payroll")
2. All visible field labels and their values
3. All buttons and links with their labels
4. Any tables: list column headers and first 3 rows of data
5. Any alerts, errors, or notifications
6. Navigation breadcrumbs or menu path

Be thorough and specific. Use actual text from the screenshot.`;

      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');

      const resp = await fetch(settings.ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: visionModel,
          messages: [{ role: 'user', content: visionPrompt, images: [base64] }],
          stream: false
        })
      });

      const data = await resp.json();
      const visionResult = data.message?.content || '';

      pageContext = visionResult;

      // Update or create content div
      let contentDiv = document.getElementById('read-content-text');
      if (!contentDiv) {
        contentDiv = document.createElement('div');
        contentDiv.id = 'read-content-text';
        contentDiv.style.cssText = 'font-size:11px;line-height:1.5;white-space:pre-wrap;color:#334155;margin-bottom:8px;';
        readContent.appendChild(contentDiv);
      }
      contentDiv.textContent = visionResult;

      // Update or create ready div
      let readyDiv = document.getElementById('read-ready');
      if (!readyDiv) {
        readyDiv = document.createElement('div');
        readyDiv.id = 'read-ready';
        readyDiv.style.cssText = 'padding:6px;background:#f0fdf4;border-radius:6px;font-size:11px;color:#166534;border:1px solid #bbf7d0;margin-bottom:8px;';
        readContent.appendChild(readyDiv);
      }

      if (isLiveReading) {
        statusDiv.textContent = `Live: ${source.name} - Last updated: ${new Date().toLocaleTimeString()}`;
        statusDiv.style.color = '#0070F3';
        readyDiv.textContent = 'LIVE MODE \u2014 Screen is being monitored. Switch to Chat to ask questions.';
        readyDiv.style.background = '#eff6ff';
        readyDiv.style.borderColor = '#bfdbfe';
        readyDiv.style.color = '#1e40af';
      } else {
        statusDiv.textContent = 'Page analyzed by vision model:';
        statusDiv.style.color = '#166534';
        readyDiv.textContent = 'READY \u2014 Switch to Chat to ask questions about this page.';
        readyDiv.style.background = '#f0fdf4';
        readyDiv.style.borderColor = '#bbf7d0';
        readyDiv.style.color = '#166534';
      }
    } else {
      statusDiv.textContent = 'No vision model found. Pull one with: ollama pull llava:7b';
      statusDiv.style.color = '#9a3412';
      let fallbackDiv = document.getElementById('read-fallback');
      if (!fallbackDiv) {
        fallbackDiv = document.createElement('div');
        fallbackDiv.id = 'read-fallback';
        fallbackDiv.style.cssText = 'margin-top:8px;padding:8px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;font-size:11px;color:#9a3412;';
        readContent.appendChild(fallbackDiv);
      }
      fallbackDiv.textContent = 'To auto-read Oracle pages, install a vision model:\n\n  ollama pull llava:7b  (~4.7GB)\n\nThen restart Savvy. You can still chat about Oracle HCM in the Chat tab.';
      pageContext = '[Screenshot captured from: ' + source.name + '] User should describe what they see.';
    }
  } catch (err) {
    statusDiv.textContent = 'Capture failed: ' + err.message;
    statusDiv.style.color = '#991b1b';
  }
}

function startLiveRead() {
  if (!selectedWindow || isLiveReading) return;

  isLiveReading = true;

  // Update UI - show stop button
  const liveBtn = document.getElementById('liveReadBtn');
  if (liveBtn) {
    liveBtn.textContent = 'Stop Live';
    liveBtn.classList.add('live-active');
  }

  // Capture immediately, then every 3 seconds
  captureWindow(selectedWindow, true);
  liveReadInterval = setInterval(() => {
    if (isLiveReading && selectedWindow) {
      captureWindow(selectedWindow, true);
    }
  }, 3000);
}

function stopLiveRead() {
  isLiveReading = false;
  if (liveReadInterval) {
    clearInterval(liveReadInterval);
    liveReadInterval = null;
  }

  // Update UI - show live button
  const liveBtn = document.getElementById('liveReadBtn');
  if (liveBtn) {
    liveBtn.textContent = 'Live Read';
    liveBtn.classList.remove('live-active');
  }

  // Update status
  const statusDiv = document.getElementById('read-status');
  if (statusDiv) {
    statusDiv.textContent = 'Live reading stopped.';
    statusDiv.style.color = '#64748b';
  }
}

// ── UI Helpers ──
function addMessage(text, who) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  const avatar = who === 'bot' ? 'EQ' : 'You';
  if (who === 'bot') {
    div.innerHTML = `<div class="msg-avatar">${avatar}</div><div class="msg-text">${text ? formatMarkdown(text) : ''}</div>`;
  } else {
    div.innerHTML = `<div class="msg-avatar">${avatar}</div><div class="msg-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function formatMarkdown(text) {
  let html = escapeHtml(text);
  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Bullet points: lines starting with - or *
  html = html.replace(/^[\-\*] (.+)$/gm, '<div style="padding-left:12px;margin:2px 0;">&#8226; $1</div>');
  // Numbered lists: lines starting with 1. 2. etc
  html = html.replace(/^(\d+)\. (.+)$/gm, '<div style="padding-left:12px;margin:2px 0;"><b>$1.</b> $2</div>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

function removeThinking(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

// ── Collapse/Expand ──
async function toggleCollapse() {
  const app = document.getElementById('app');
  const bubbleOverlay = document.getElementById('bubble-overlay');

  isCollapsed = !isCollapsed;

  if (isCollapsed) {
    stopLiveRead();
    // Switch to bubble mode - hide app, show bubble overlay
    app.style.display = 'none';
    bubbleOverlay.style.display = 'block';
    await window.savvy.setUiState('isCollapsed', true);

    // Move window to bottom-right corner (saves current size first)
    await window.savvy.moveOverlayToCorner();
  } else {
    await expandFromBubble();
  }
}

// Expand from bubble
async function expandFromBubble() {
  console.log('expandFromBubble called');
  const app = document.getElementById('app');
  const bubbleOverlay = document.getElementById('bubble-overlay');

  isCollapsed = false;
  app.style.display = 'flex';
  bubbleOverlay.style.display = 'none';
  await window.savvy.setUiState('isCollapsed', false);

  // Clear bubble mode flag first so resize handler doesn't overwrite
  await window.savvy.clearBubbleMode();

  // Get saved size from store
  const restoreSize = {
    width: await window.savvy.getUiState('overlayWidth') || 420,
    height: await window.savvy.getUiState('overlayHeight') || 750
  };

  // Get saved position from store
  const restorePos = {
    x: await window.savvy.getUiState('overlayX'),
    y: await window.savvy.getUiState('overlayY')
  };

  console.log('Restoring size:', restoreSize, 'position:', restorePos);

  // Restore window size and position
  await window.savvy.setOverlaySize(restoreSize);

  // Center if saved position is in corner or off-screen
  if (restorePos.x !== null && restorePos.y !== null) {
    const centered = await window.savvy.centerIfNeeded(restorePos.x, restorePos.y);
    if (!centered) {
      await window.savvy.setOverlayPosition(restorePos);
    }
  } else {
    await window.savvy.centerWindow();
  }
}

// ── Settings ──
async function loadSettings() {
  document.getElementById('setOllamaUrl').value = settings.ollamaUrl || '';
  document.getElementById('setOllamaModel').value = settings.ollamaModel || '';
  document.getElementById('setOracleUrl').value = settings.oracleUrl || '';
  document.getElementById('setOracleUser').value = settings.oracleUser || '';
  document.getElementById('setOraclePass').value = settings.oraclePass || '';

  const statusEl = document.getElementById('status');
  if (statusEl) {
    if (settings.ollamaUrl) {
      statusEl.textContent = 'Ready';
      statusEl.style.color = '#166534';
    } else {
      statusEl.textContent = 'Configure settings';
      statusEl.style.color = '#64748b';
    }
  }

  const wasCollapsed = await window.savvy.getUiState('isCollapsed');
  if (wasCollapsed) {
    const app = document.getElementById('app');
    const bubbleOverlay = document.getElementById('bubble-overlay');
    app.style.display = 'none';
    bubbleOverlay.style.display = 'block';
    isCollapsed = true;
    await window.savvy.moveOverlayToCorner();
  }
}

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  await loadInitialState();

  // Brand icon fallback
  document.querySelectorAll('.brand-icon').forEach(img => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
      const span = document.createElement('span');
      span.style.cssText = `font-weight:700;font-size:${img.dataset.fallbackSize};color:${img.dataset.fallbackColor};`;
      span.textContent = 'EQ';
      img.parentNode.appendChild(span);
    });
  });

  // Close button
  document.getElementById('closeBtn').addEventListener('click', () => {
    window.savvy.closeOverlay();
  });

  // Collapse button
  document.getElementById('collapseBtn').addEventListener('click', toggleCollapse);

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // Collapsible sections
  document.getElementById('readSectionHeader').addEventListener('click', () => {
    const header = document.getElementById('readSectionHeader');
    const content = document.getElementById('readSectionContent');
    header.classList.toggle('expanded');
    content.classList.toggle('expanded');

    // Load windows when expanding Read Page section
    if (content.classList.contains('expanded')) {
      loadWindows();
    }
  });

  document.getElementById('understandSectionHeader').addEventListener('click', () => {
    const header = document.getElementById('understandSectionHeader');
    const content = document.getElementById('understandSectionContent');
    header.classList.toggle('expanded');
    content.classList.toggle('expanded');
  });

  // Chat
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
  });

  // Clear chat
  document.getElementById('clearChatBtn').addEventListener('click', () => {
    document.getElementById('messages').innerHTML = '';
    addMessage('Chat cleared. Ask me anything about Oracle HCM.', 'bot');
  });

  // Quick actions
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.q) {
        document.getElementById('chatInput').value = btn.dataset.q;
        sendMessage();
      }
    });
  });

  // Read Page buttons
  document.getElementById('refreshWindows').addEventListener('click', loadWindows);
  document.getElementById('backToWindows').addEventListener('click', () => {
    stopLiveRead();
    document.getElementById('window-list').style.display = 'block';
    document.getElementById('read-content').style.display = 'none';
    document.getElementById('read-controls').style.display = 'none';
    document.getElementById('backToWindows').style.display = 'none';
    loadWindows();
  });

  // Live Read button
  document.getElementById('liveReadBtn').addEventListener('click', () => {
    if (isLiveReading) {
      stopLiveRead();
    } else {
      startLiveRead();
    }
  });

  // Understand button
  document.getElementById('understandBtn').addEventListener('click', runDiscovery);

  // Save settings
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const newSettings = {
      ollamaUrl: document.getElementById('setOllamaUrl').value,
      ollamaModel: document.getElementById('setOllamaModel').value,
      oracleUrl: document.getElementById('setOracleUrl').value,
      oracleUser: document.getElementById('setOracleUser').value,
      oraclePass: document.getElementById('setOraclePass').value,
    };
    settings = { ...settings, ...newSettings };
    await window.savvy.setSettings(settings);

    const status = document.getElementById('savedMsg');
    status.textContent = 'Settings saved!';
    status.style.display = 'block';
    setTimeout(() => { status.style.display = 'none'; }, 2000);
  });

  await loadSettings();

  // Bubble overlay click handler - add to multiple elements for reliability
  const bubbleOverlay = document.getElementById('bubble-overlay');
  const bubbleContainer = document.querySelector('.bubble-container');
  const moon = document.querySelector('.moon');

  bubbleOverlay.addEventListener('click', expandFromBubble);
  if (bubbleContainer) bubbleContainer.addEventListener('click', expandFromBubble);
  if (moon) moon.addEventListener('click', expandFromBubble);

  // Load conversation history
  if (conversationHistory.length > 0) {
    const container = document.getElementById('messages');
    // Keep the welcome message, add history after
    conversationHistory.forEach(msg => {
      if (msg.role === 'user') {
        addMessage(msg.content, 'user');
      } else if (msg.role === 'bot') {
        addMessage(msg.content, 'bot');
      }
    });
    container.scrollTop = container.scrollHeight;
  }
});

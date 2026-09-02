const { HCMDiscovery } = require('./hcm-discovery');

let settings = {
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'phi3:mini',
  oracleUrl: '',
  oracleUser: '',
  oraclePass: '',
  alwaysOnTop: true,
};

let currentUserPersonNumber = null; // Set after first worker lookup
let currentUserDisplayName = null;

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

  // Detect current user from Oracle credentials
  detectCurrentUser();
}

// Detect current user by matching Oracle username to worker record
async function detectCurrentUser() {
  if (!settings.oracleUrl || !settings.oracleUser) return;
  try {
    const url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05/workers?onlyData=true&q=UserName=\'' + encodeURIComponent(settings.oracleUser) + '\'&limit=1';
    const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
    if (result.ok && result.data?.items?.length > 0) {
      const me = result.data.items[0];
      currentUserPersonNumber = me.PersonNumber || me.personNumber;
      currentUserDisplayName = me.DisplayName || me.displayName || ((me.FirstName || me.firstName || '') + ' ' + (me.LastName || me.lastName || '')).trim();
      console.log('[Savvy] Current user detected:', currentUserDisplayName, '#', currentUserPersonNumber);
    }
  } catch (err) {
    console.log('[Savvy] Could not detect current user:', err.message);
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
    return { type: 'error', text: '[ERROR] Oracle Fusion not configured. Set URL, username, and password in Settings.' };
  }

  let endpoints = HCM_ENDPOINTS.filter(ep => ep.keywords.some(kw => msg.includes(kw)));

  // Skip absence records unless user explicitly asks about absences
  const absenceExplicit = /\babsence\b|\bleave\b|\btime off\b|\bvacation\b|\bsick\b|\babsences\b|\bleaves\b/i.test(userMessage);
  if (!absenceExplicit) {
    endpoints = endpoints.filter(ep => ep.path !== '/absences');
  }

  if (endpoints.length === 0) {
    const ctx = getDiscoveryContext();
    if (ctx) return { type: 'text', text: ctx };
    return { type: 'text', text: '[INFO] No specific data matched. Try asking about employees, absences, departments, jobs, grades, time, payroll, benefits, goals, learning, recruiting, etc.' };
  }

  // Step 1: Detect "my" context — use stored current user
  const isMyQuery = /\bmy\b|\bme\b|\bmine\b|\bmyself\b/i.test(userMessage);
  if (isMyQuery && currentUserPersonNumber) {
    return await fetchDataForPerson({
      personNumber: currentUserPersonNumber,
      displayName: currentUserDisplayName || 'You',
    }, endpoints);
  }

  // Step 2: Detect Person Number (alphanumeric like NM290, or pure numeric)
  let personNumber = null;
  const pnMatch = msg.match(/person\s*(?:number|#|no\.?)\s*([A-Za-z0-9]+)/i)
    || msg.match(/\b([A-Z]{2,}\d{2,})\b/)
    || msg.match(/\b(\d{4,})\b/);
  if (pnMatch) {
    personNumber = pnMatch[1].toUpperCase();
  }

  // Step 3: Detect person name in query
  let personName = null;
  if (!personNumber) {
    const nameMatch = msg.match(/(?:for|of|belonging to|assigned to)\s+([a-z][a-z\s]+?)(?:'s|\s|$)/i)
      || msg.match(/([a-z][a-z\s]+?)'s\s+(?:absence|leave|time|payroll|checklist|phone|email|address|data|info)/i);
    if (nameMatch) {
      const guess = nameMatch[1].trim();
      const isKeyword = HCM_ENDPOINTS.some(ep => ep.keywords.some(kw => guess.includes(kw)));
      if (guess.length >= 2 && !isKeyword) {
        personName = guess;
      }
    }
  }

  // Step 3: Resolve person — either by number or by name search
  let resolvedPersons = [];

  if (personNumber) {
    // Direct lookup by PersonNumber
    try {
      const url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05/workers?onlyData=true&q=PersonNumber=\'' + encodeURIComponent(personNumber) + '\'&limit=5';
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      if (result.ok && result.data?.items?.length > 0) {
        resolvedPersons = result.data.items.map(p => ({
          personNumber: p.PersonNumber,
          displayName: p.DisplayName || ((p.FirstName || '') + ' ' + (p.LastName || '')).trim(),
          department: p.DepartmentName || '',
          job: p.JobName || '',
        }));
      }
    } catch {}
  } else if (personName) {
    // Search by name
    try {
      const url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05/workers?onlyData=true&q=DisplayName LIKE \'%25' + encodeURIComponent(personName) + '%25\'&sortBy=DisplayName:asc&limit=10';
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      if (result.ok && result.data?.items?.length > 0) {
        resolvedPersons = result.data.items.map(p => ({
          personNumber: p.PersonNumber,
          displayName: p.DisplayName || ((p.FirstName || '') + ' ' + (p.LastName || '')).trim(),
          department: p.DepartmentName || '',
          job: p.JobName || '',
        }));
      }
    } catch {}
  }

  // Step 4: Handle resolution results
  if (personNumber || personName) {
    if (resolvedPersons.length === 0) {
      return { type: 'no-data', text: 'No employee found matching "' + (personNumber || personName) + '". Please check the name or person number and try again.' };
    }
    if (resolvedPersons.length > 1) {
      // Multiple matches — ask user to choose
      return {
        type: 'choose-person',
        text: 'Found ' + resolvedPersons.length + ' matching employees. Please select one:',
        persons: resolvedPersons,
        endpoints: endpoints,
      };
    }
    // Exactly one match — proceed with that person
    const person = resolvedPersons[0];
    return await fetchDataForPerson(person, endpoints);
  }

  // No person mentioned — fetch general data
  return await fetchDataForPerson(null, endpoints);
}

async function fetchDataForPerson(person, endpoints) {
  const results = [];
  for (const ep of endpoints) {
    try {
      let url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05' + ep.path + ep.params;
      if (person && ep.path !== '/absenceTypesLOV') {
        url += '&q=PersonNumber=\'' + encodeURIComponent(person.personNumber) + '\'';
      }
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      if (!result.ok) {
        // Strict access control — show clear error, no fallback
        if (result.status === 401) {
          return { type: 'access-denied', text: 'Authentication failed. Please check your Oracle credentials in Settings.' };
        }
        if (result.status === 403) {
          const who = person ? ' for ' + person.displayName : '';
          return { type: 'access-denied', text: 'Access denied. You do not have permission to view ' + ep.name.toLowerCase() + who + '. Contact your Oracle administrator.' };
        }
        throw new Error('HTTP ' + result.status + ' ' + (result.statusText || '') + (result.body ? ' — ' + result.body.slice(0, 200) : ''));
      }
      const items = result.data?.items || [];
      const label = person ? ep.name + ' for ' + person.displayName : ep.name;
      if (items.length > 0) {
        results.push(`[ORACLE DATA — ${label}] ${items.length} records found:`);
        items.slice(0, 10).forEach((item, i) => {
          results.push(`  ${i + 1}. ${formatItem(ep.path, item)}`);
        });
        results.push(`__HTML__${label}__${ep.path}__${items.length}__${JSON.stringify(items)}`);
      } else {
        results.push(`[ORACLE DATA — ${label}] No records found.`);
      }
    } catch (err) {
      // Don't fall back to cache for network errors — show the error
      results.push(`[ERROR — ${ep.name}] ${err.message}`);
    }
  }
  return { type: 'data', text: '\n' + results.join('\n'), results };
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
    return name;
  },
  '/absences': (a) => `${a.AbsenceType || a.AbsenceTypeName || 'N/A'} — ${a.StartDate || 'N/A'}`,
  '/organizations': (d) => d.Name || d.OrganizationName || 'N/A',
  '/locations': (l) => l.Name || 'N/A',
  '/jobs': (j) => j.Name || 'N/A',
  '/positions': (p) => p.Name || 'N/A',
  '/grades': (g) => g.Name || 'N/A',
  '/timeRecords': (t) => t.EmployeeName || t.WorkerName || 'N/A',
  '/payrollRelationships': (p) => p.EmployeeName || p.PersonNumber || 'N/A',
  '/allocatedChecklists': (c) => c.ChecklistName || 'N/A',
  '/areasOfResponsibility': (r) => r.ResponsibilityType || r.PersonName || 'N/A',
  '/assignmentStatuses': (s) => s.Name || 'N/A',
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
  const name = item.DisplayName || item.displayName
    || item.Name || item.name
    || item.AbsenceTypeName || item.absenceTypeName
    || item.EmployeeName || item.employeeName
    || item.ChecklistName || item.checklistName
    || item.FullName || item.fullName
    || item.PersonName || item.personName
    || ((item.FirstName || item.firstName || '') + ' ' + (item.LastName || item.lastName || '')).trim();
  if (name) return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(name)}</b></span></div>`;
  // Fallback: try to find any field that looks like an ID or label
  const keys = Object.keys(item).filter(k => !k.startsWith('_') && typeof item[k] !== 'object');
  if (keys.length === 0) return `<div class="data-row"><span class="data-idx">#${idx}</span></div>`;
  // Prefer PersonNumber or any field with "name" or "number" in key
  const labelKey = keys.find(k => /person.?number|name|id|code|title/i.test(k)) || keys[0];
  return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(item[labelKey])}</b></span></div>`;
}

const HTML_FORMATTERS = {
  '/absenceTypesLOV': (t, idx) => {
    const name = t.AbsenceTypeName || t.absenceTypeName || t.Name || t.name || '';
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(name || '—')}</b></span></div>`;
  },
  '/workers': (w, idx) => {
    const name = w.DisplayName || w.displayName || ((w.FirstName || w.firstName || '') + ' ' + (w.LastName || w.lastName || '')).trim();
    if (!name || name === ' ') {
      const keys = Object.keys(w).filter(k => !k.startsWith('_') && typeof w[k] !== 'object').slice(0, 1);
      return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(keys.length ? w[keys[0]] : '?')}</b></span></div>`;
    }
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(name)}</b></span></div>`;
  },
  '/absences': (a, idx) => {
    const type = a.AbsenceType || a.absenceType || a.AbsenceTypeName || a.absenceTypeName || '';
    const start = a.StartDate || a.startDate || '';
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(type || '—')}</b></span> <span class="data-field">${formatDate(start)}</span></div>`;
  },
  '/organizations': (d, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(d.Name || d.OrganizationName || '—')}</b></span></div>`;
  },
  '/locations': (l, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(l.Name || '—')}</b></span></div>`;
  },
  '/jobs': (j, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(j.Name || '—')}</b></span></div>`;
  },
  '/positions': (p, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(p.Name || '—')}</b></span></div>`;
  },
  '/grades': (g, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(g.Name || '—')}</b></span></div>`;
  },
  '/timeRecords': (t, idx) => {
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(t.EmployeeName || t.WorkerName || '—')}</b></span></div>`;
  },
};

const SUGGESTIONS = {
  '/workers': 'You can ask about their absences, department, job, location, payroll, phone, email, or address.',
  '/organizations': 'You can ask about workers in this department, or its location and manager.',
  '/locations': 'You can ask about workers at this location.',
  '/jobs': 'You can ask about positions, grades, or workers with this job.',
  '/positions': 'You can ask about the department, job, or workers in this position.',
  '/grades': 'You can ask about grade rates, grade ladders, or workers at this grade.',
  '/absences': 'You can ask about absence types, absence plans, or specific employee absences.',
  '/absenceTypesLOV': 'You can ask about absence records for a specific type.',
  '/timeRecords': 'You can ask about a specific employee\'s time records.',
  '/payrollRelationships': 'You can ask about salaries, element entries, or pay advances.',
  '/benefitEnrollments': 'You can ask about benefit groups, enrollment opportunities, or plan comparisons.',
  '/performanceGoals': 'You can ask about goal plans, goal progress, or performance evaluations.',
  '/learnerLearningRecords': 'You can ask about learning events or self-paced learning items.',
  '/journeys': 'You can ask about worker journeys, journey tasks, or journey allocations.',
  '/recruitingJobRequisitions': 'You can ask about job applications, candidates, or job offers.',
  '/tasks': 'You can ask about pending approvals or workflow notifications.',
  '/documentRecords': 'You can ask about specific document types or delivery preferences.',
};

function buildFormattedList(epName, epPath, items, maxShow = 10, isTypeList = false) {
  const total = items.length;
  const showing = Math.min(total, maxShow);

  // Type lists: show as simple bullet list, not numbered rows
  if (isTypeList) {
    let html = `<div class="data-section"><div class="data-header"><span class="data-icon">&#9679;</span> <b>${escapeHtml(epName)}</b> — ${total} available</div>`;
    html += '<div style="padding:4px 8px;">';
    for (let i = 0; i < showing; i++) {
      const name = items[i].AbsenceTypeName || items[i].absenceTypeName || items[i].Name || items[i].name || JSON.stringify(items[i]).slice(0, 50);
      html += `<div style="padding:3px 0;font-size:12px;">&#8226; <b>${escapeHtml(name)}</b></div>`;
    }
    if (total > maxShow) {
      html += `<div class="data-more">${total - maxShow} more types not shown.</div>`;
    }
    const hint = SUGGESTIONS[epPath];
    if (hint) html += `<div class="data-more" style="color:#818cf8;margin-top:4px;">${escapeHtml(hint)}</div>`;
    html += '</div></div>';
    return html;
  }

  // Regular records: show as numbered rows
  let html = `<div class="data-section"><div class="data-header"><span class="data-icon">&#9679;</span> <b>${escapeHtml(epName)}</b> — ${total} record${total !== 1 ? 's' : ''}</div>`;
  for (let i = 0; i < showing; i++) {
    html += formatItemAsHTML(epPath, items[i], i + 1);
  }
  if (total > maxShow) {
    html += `<div class="data-more">${total - maxShow} more records not shown. Ask me to "show all ${epName.toLowerCase()}" to see the full list.</div>`;
  }
  const hint = SUGGESTIONS[epPath];
  if (hint) html += `<div class="data-more" style="color:#818cf8;margin-top:4px;">${escapeHtml(hint)}</div>`;
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

  // Handle choose-person: show selection buttons
  if (fetchedData.type === 'choose-person') {
    const container = document.getElementById('messages');
    const chooseDiv = document.createElement('div');
    chooseDiv.className = 'msg bot';
    let buttonsHtml = fetchedData.persons.map((p, i) =>
      `<button class="person-select-btn" data-pn="${escapeHtml(p.personNumber)}" data-name="${escapeHtml(p.displayName)}" data-eps="${escapeHtml(JSON.stringify(fetchedData.endpoints.map(e => e.path)))}" style="display:block;width:100%;text-align:left;padding:8px 12px;margin:4px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;font-size:12px;border-left:3px solid #0070F3;">
        <b>${escapeHtml(p.displayName)}</b> &middot; #${escapeHtml(p.personNumber)}${p.department ? ' &middot; ' + escapeHtml(p.department) : ''}
      </button>`
    ).join('');
    chooseDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text"><div style="margin-bottom:6px;">${escapeHtml(fetchedData.text)}</div>${buttonsHtml}</div>`;
    container.appendChild(chooseDiv);
    container.scrollTop = container.scrollHeight;

    // Attach click handlers
    chooseDiv.querySelectorAll('.person-select-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pn = btn.dataset.pn;
        const name = btn.dataset.name;
        const eps = JSON.parse(btn.dataset.eps);
        btn.disabled = true;
        btn.style.opacity = '0.5';
        const epDefs = eps.map(p => HCM_ENDPOINTS.find(e => e.path === p)).filter(Boolean);
        const person = { personNumber: pn, displayName: name };
        const result = await fetchDataForPerson(person, epDefs);
        if (result.type === 'data' && result.text) {
          // Show the data
          const htmlLines = result.text.split('\n').filter(l => l.startsWith('__HTML__'));
          let html = '';
          for (const line of htmlLines) {
            const parts = line.split('__');
            try {
              const items = JSON.parse(parts.slice(5).join('__'));
              html += buildFormattedList(parts[2], parts[3], items);
            } catch {}
          }
          if (html) {
            const dataDiv = document.createElement('div');
            dataDiv.className = 'msg bot';
            dataDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text">${html}</div>`;
            container.appendChild(dataDiv);
          }
          const llmText = result.text.split('\n').filter(l => !l.startsWith('__HTML__')).join('\n');
          const botMsg = addMessage('', 'bot');
          const sysPrompt2 = 'You are Savvy, an Oracle Fusion HCM assistant. Format data with bullet points. No raw JSON.';
          const reply = await callLLM([{ role: 'system', content: sysPrompt2 }, { role: 'user', content: llmText }], (chunk) => {
            botMsg.querySelector('.msg-text').innerHTML = formatMarkdown(fullText);
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
          });
        } else if (result.type === 'no-data') {
          addMessage(result.text, 'bot');
        }
        container.scrollTop = container.scrollHeight;
      });
    });
    return;
  }

  // Handle no-data
  if (fetchedData.type === 'no-data') {
    addMessage(fetchedData.text, 'bot');
    return;
  }

  // Handle error
  if (fetchedData.type === 'error') {
    addMessage(fetchedData.text, 'bot');
    return;
  }

  // Handle access-denied
  if (fetchedData.type === 'access-denied') {
    const container = document.getElementById('messages');
    const denyDiv = document.createElement('div');
    denyDiv.className = 'msg bot';
    denyDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text" style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;">${escapeHtml(fetchedData.text)}</div>`;
    container.appendChild(denyDiv);
    container.scrollTop = container.scrollHeight;
    return;
  }

  // Handle data
  let htmlSections = '';
  if (fetchedData && fetchedData.text) {
    const htmlLines = fetchedData.text.split('\n').filter(l => l.startsWith('__HTML__'));
    for (const line of htmlLines) {
      const parts = line.split('__');
      try {
        const items = JSON.parse(parts.slice(5).join('__'));
        htmlSections += buildFormattedList(parts[2], parts[3], items);
      } catch {}
    }
    const llmData = fetchedData.text.split('\n').filter(l => !l.startsWith('__HTML__')).join('\n');
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
    // Data already shown — skip LLM call
    conversationHistory.push({ role: 'user', content: msg, timestamp: Date.now() });
    conversationHistory.push({ role: 'bot', content: '[Data displayed in formatted list]', timestamp: Date.now() });
    try { await window.savvy.invoke('set-conversation-history', JSON.stringify(conversationHistory.slice(-100))); } catch {}
    return;
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
  // ── Core HR & Workforce ──
  { name: 'Workers', path: '/workers', params: '?onlyData=true&limit=20', keywords: ['employee', 'worker', 'person', 'team', 'headcount', 'hire', 'name', 'number'] },
  { name: 'Employees', path: '/emps', params: '?onlyData=true&limit=20', keywords: ['emp', 'employee list'] },
  { name: 'Public Workers', path: '/publicWorkers', params: '?onlyData=true&limit=20', keywords: ['public worker', 'public profile'] },
  { name: 'Organizations', path: '/organizations', params: '?onlyData=true&limit=20', keywords: ['department', 'dept', 'org', 'organization', 'division', 'team'] },
  { name: 'Positions', path: '/positions', params: '?onlyData=true&limit=20', keywords: ['position', 'posting', 'job position'] },
  { name: 'Jobs', path: '/jobs', params: '?onlyData=true&limit=20', keywords: ['job', 'role', 'position title', 'job title'] },
  { name: 'Locations', path: '/locations', params: '?onlyData=true&limit=20', keywords: ['location', 'office', 'site', 'address', 'workplace'] },
  { name: 'Areas of Responsibility', path: '/areasOfResponsibility', params: '?onlyData=true&limit=20', keywords: ['responsibility', 'representative', 'aor'] },
  { name: 'Person Notes', path: '/personNotes', params: '?onlyData=true&limit=20', keywords: ['note', 'person note', 'comment'] },
  { name: 'HCM Contacts', path: '/hcmContacts', params: '?onlyData=true&limit=20', keywords: ['contact', 'emergency', 'next of kin'] },

  // ── Absences ──
  { name: 'Absences', path: '/absences', params: '?onlyData=true&limit=20', keywords: ['absence', 'leave', 'time off', 'vacation', 'sick', 'absence record', 'leave record', 'my absences', 'leave history'] },
  { name: 'Absence Types', path: '/absenceTypesLOV', params: '?onlyData=true&limit=50', keywords: ['absence type', 'leave type', 'absence category', 'types of absence', 'types of leave'], isTypeList: true },
  { name: 'Absence Plans', path: '/absencePlansLOV', params: '?onlyData=true&limit=50', keywords: ['absence plan', 'leave plan', 'entitlement'] },
  { name: 'Absence Calendars', path: '/absenceCalendars', params: '?onlyData=true&limit=20', keywords: ['absence calendar', 'leave calendar', 'org calendar'] },
  { name: 'Absence No Entitlements', path: '/absenceNoEntitlements', params: '?onlyData=true&limit=20', keywords: ['absence no entitlement', 'no entitlement'] },

  // ── Payroll ──
  { name: 'Payroll Relationships', path: '/payrollRelationships', params: '?onlyData=true&limit=20', keywords: ['payroll', 'salary', 'pay', 'wage', 'earnings'] },
  { name: 'Element Entries', path: '/elementEntries', params: '?onlyData=true&limit=20', keywords: ['element entry', 'pay element', 'earning', 'deduction'] },
  { name: 'Calculation Entries', path: '/calculationEntries', params: '?onlyData=true&limit=20', keywords: ['calculation', 'calc card', 'payroll calculation'] },
  { name: 'Flow Instances', path: '/flowInstances', params: '?onlyData=true&limit=20', keywords: ['flow instance', 'payroll flow', 'payroll run'] },
  { name: 'Flow Patterns', path: '/flowPatterns', params: '?onlyData=true&limit=20', keywords: ['flow pattern', 'payroll process'] },
  { name: 'Pay Advances', path: '/payAdvances', params: '?onlyData=true&limit=20', keywords: ['pay advance', 'salary advance', 'advance request'] },
  { name: 'Plan Balances', path: '/planBalances', params: '?onlyData=true&limit=20', keywords: ['plan balance', 'balance', 'pay balance'] },

  // ── Benefits ──
  { name: 'Benefit Enrollments', path: '/benefitEnrollments', params: '?onlyData=true&limit=20', keywords: ['benefit enrollment', 'benefit', 'enrollment'] },
  { name: 'Benefit Groups', path: '/benefitGroups', params: '?onlyData=true&limit=20', keywords: ['benefit group', 'benefit plan group'] },
  { name: 'Benefit Opportunities', path: '/benefitEnrollmentOpportunities', params: '?onlyData=true&limit=20', keywords: ['benefit opportunity', 'enrollment opportunity'] },
  { name: 'Benefit Year Periods', path: '/benefitYearPeriods', params: '?onlyData=true&limit=20', keywords: ['benefit year', 'benefit period'] },
  { name: 'Benefits Comparison', path: '/benefitPlansComparison', params: '?onlyData=true&limit=20', keywords: ['compare benefits', 'benefit comparison'] },

  // ── Compensation ──
  { name: 'Salaries', path: '/salaries', params: '?onlyData=true&limit=20', keywords: ['salary', 'compensation', 'pay rate', 'annual salary'] },
  { name: 'Salary Basis', path: '/salaryBasisLov', params: '?onlyData=true&limit=20', keywords: ['salary basis', 'pay basis'] },
  { name: 'Grade Rates', path: '/gradeRates', params: '?onlyData=true&limit=20', keywords: ['grade rate', 'pay grade', 'salary grade'] },
  { name: 'Grades', path: '/grades', params: '?onlyData=true&limit=20', keywords: ['grade', 'level', 'band', 'job grade'] },
  { name: 'Grade Ladders', path: '/gradeLadders', params: '?onlyData=true&limit=20', keywords: ['grade ladder', 'career ladder', 'progression'] },
  { name: 'Compensation Percentiles', path: '/compensationPeerSalaryPercentiles', params: '?onlyData=true&limit=20', keywords: ['percentile', 'compa-ratio', 'market position'] },
  { name: 'Stock Profiles', path: '/compensationStockProfiles', params: '?onlyData=true&limit=20', keywords: ['stock', 'equity', 'stock profile'] },

  // ── Time & Labor ──
  { name: 'Time Records', path: '/timeRecords', params: '?onlyData=true&limit=20', keywords: ['time record', 'time card', 'timesheet', 'hours worked'] },
  { name: 'Time Record Groups', path: '/timeRecordGroups', params: '?onlyData=true&limit=20', keywords: ['time group', 'time entry group'] },
  { name: 'Time Attributes', path: '/timeAttributes', params: '?onlyData=true&limit=20', keywords: ['time attribute', 'time entry'] },
  { name: 'Web Clock Events', path: '/webClockEvents', params: '?onlyData=true&limit=20', keywords: ['clock', 'punch', 'web clock', 'clock in', 'clock out'] },
  { name: 'Schedule Requests', path: '/scheduleRequests', params: '?onlyData=true&limit=20', keywords: ['schedule request', 'shift request', 'schedule change'] },
  { name: 'Geofences', path: '/timeGeofences', params: '?onlyData=true&limit=20', keywords: ['geofence', 'location fence', 'geo boundary'] },
  { name: 'Attendance Violations', path: '/attendanceViolations', params: '?onlyData=true&limit=20', keywords: ['attendance', 'violation', 'tardy', 'absence violation'] },

  // ── Goals & Performance ──
  { name: 'Performance Goals', path: '/performanceGoals', params: '?onlyData=true&limit=20', keywords: ['performance goal', 'goal', 'objective'] },
  { name: 'Goal Plans', path: '/goalPlans', params: '?onlyData=true&limit=20', keywords: ['goal plan', 'goal template'] },
  { name: 'Goal Plan Assignees', path: '/goalPlanAssignees', params: '?onlyData=true&limit=20', keywords: ['goal assignee', 'goal assignment'] },
  { name: 'Goal Plan Weights', path: '/goalPlanGoalWeights', params: '?onlyData=true&limit=20', keywords: ['goal weight', 'goal priority'] },
  { name: 'Goals Progress', path: '/goalsProgressDetails', params: '?onlyData=true&limit=20', keywords: ['goal progress', 'goal status', 'goal completion'] },
  { name: 'Library Goals', path: '/libraryGoals', params: '?onlyData=true&limit=20', keywords: ['library goal', 'goal library', 'predefined goal'] },
  { name: 'Explore Goals', path: '/exploreGoals', params: '?onlyData=true&limit=20', keywords: ['explore goal', 'search goal', 'find goal'] },
  { name: 'Performance Evaluations', path: '/performanceEvaluations', params: '?onlyData=true&limit=20', keywords: ['performance review', 'evaluation', 'appraisal', 'review document'] },
  { name: 'Performance Cycles', path: '/perfCycles', params: '?onlyData=true&limit=20', keywords: ['performance cycle', 'review cycle', 'appraisal cycle'] },

  // ── Talent & Learning ──
  { name: 'Talent Person Profiles', path: '/talentPersonProfiles', params: '?onlyData=true&limit=20', keywords: ['talent profile', 'person profile', 'competency', 'skill profile'] },
  { name: 'Talent Ratings', path: '/talentRatings', params: '?onlyData=true&limit=20', keywords: ['talent rating', 'competency rating', 'proficiency'] },
  { name: 'Talent Feedback', path: '/talentFeedbackSuggestions', params: '?onlyData=true&limit=20', keywords: ['feedback', 'talent feedback', 'peer feedback'] },
  { name: 'Learner Records', path: '/learnerLearningRecords', params: '?onlyData=true&limit=20', keywords: ['learning record', 'course', 'training', 'learning assignment'] },
  { name: 'Learning Events', path: '/learningEvents', params: '?onlyData=true&limit=20', keywords: ['learning event', 'training event', 'class'] },
  { name: 'Learning Items', path: '/learningSelfPacedItems', params: '?onlyData=true&limit=20', keywords: ['learning item', 'self-paced', 'online course'] },
  { name: 'Learning Audiences', path: '/learningItemAudiences', params: '?onlyData=true&limit=20', keywords: ['learning audience', 'training audience'] },
  { name: 'Learning Assignment Profiles', path: '/learningAssignmentProfiles', params: '?onlyData=true&limit=20', keywords: ['learning assignment', 'training assignment'] },

  // ── Journeys ──
  { name: 'Journeys', path: '/journeys', params: '?onlyData=true&limit=20', keywords: ['journey', 'journey template', 'onboarding journey'] },
  { name: 'Worker Journeys', path: '/workerJourneys', params: '?onlyData=true&limit=20', keywords: ['worker journey', 'my journey', 'assigned journey'] },
  { name: 'Worker Journey Tasks', path: '/workerJourneyTasks', params: '?onlyData=true&limit=20', keywords: ['journey task', 'onboarding task', 'offboarding task'] },
  { name: 'Journey Allocations', path: '/journeyAllocations', params: '?onlyData=true&limit=20', keywords: ['journey allocation', 'journey assignment'] },
  { name: 'Journey Counts', path: '/journeyCounts', params: '?onlyData=true&limit=20', keywords: ['journey count', 'journey summary'] },

  // ── Recruiting ──
  { name: 'Job Requisitions', path: '/recruitingJobRequisitions', params: '?onlyData=true&limit=20', keywords: ['requisition', 'job req', 'open position', 'hiring'] },
  { name: 'Job Applications', path: '/recruitingJobApplications', params: '?onlyData=true&limit=20', keywords: ['job application', 'applicant', 'application'] },
  { name: 'Recruiting Candidates', path: '/recruitingCandidates', params: '?onlyData=true&limit=20', keywords: ['candidate', 'recruiting candidate'] },
  { name: 'Job Offers', path: '/recruitingJobOffers', params: '?onlyData=true&limit=20', keywords: ['job offer', 'offer letter', 'offer'] },
  { name: 'Posted Jobs', path: '/recruitingJobSitePostedJobs', params: '?onlyData=true&limit=20', keywords: ['posted job', 'job posting', 'career site'] },
  { name: 'Opportunity Marketplace', path: '/recruitingOppMktOpportunities', params: '?onlyData=true&limit=20', keywords: ['opportunity', 'marketplace', 'internal gig'] },
  { name: 'Gig Details', path: '/recruitingOppMktGigDetails', params: '?onlyData=true&limit=20', keywords: ['gig', 'gig detail', 'short-term assignment'] },
  { name: 'Recruiting Events', path: '/recruitingCEEvents', params: '?onlyData=true&limit=20', keywords: ['recruiting event', 'hiring event', 'career fair'] },
  { name: 'Recruiting Campaigns', path: '/recruitingCampaignDetails', params: '?onlyData=true&limit=20', keywords: ['recruiting campaign', 'hiring campaign'] },
  { name: 'My Job Applications', path: '/recruitingMyJobApplications', params: '?onlyData=true&limit=20', keywords: ['my application', 'my job application', 'my job'] },
  { name: 'Interview Schedules', path: '/recruitingCEInterviewScheduleDetails', params: '?onlyData=true&limit=20', keywords: ['interview', 'interview schedule', 'interview details'] },

  // ── Documents & Communications ──
  { name: 'Document Records', path: '/documentRecords', params: '?onlyData=true&limit=20', keywords: ['document', 'attachment', 'file', 'record'] },
  { name: 'Communications', path: '/communicateUIMyCommunications', params: '?onlyData=true&limit=20', keywords: ['communication', 'message', 'announcement', 'notification'] },
  { name: 'Campaigns', path: '/communicateUICampaignDetails', params: '?onlyData=true&limit=20', keywords: ['campaign', 'communication campaign'] },
  { name: 'Questionnaires', path: '/questionnaires', params: '?onlyData=true&limit=20', keywords: ['questionnaire', 'survey', 'form'] },
  { name: 'Questions', path: '/questions', params: '?onlyData=true&limit=20', keywords: ['question', 'survey question'] },
  { name: 'Check-In Documents', path: '/checkInDocuments', params: '?onlyData=true&limit=20', keywords: ['check-in', 'checkin document', 'manager check-in'] },
  { name: 'Allocated Checklists', path: '/allocatedChecklists', params: '?onlyData=true&limit=20', keywords: ['checklist', 'task list', 'onboarding checklist'] },

  // ── Tasks & Transactions ──
  { name: 'Tasks', path: '/tasks', params: '?onlyData=true&limit=20', keywords: ['task', 'workflow task', 'pending task', 'todo'] },
  { name: 'BP Notifications', path: '/businessProcessNotifications', params: '?onlyData=true&limit=20', keywords: ['bp notification', 'approval notification', 'workflow notification'] },
  { name: 'BP Transactions', path: '/businessProcessTransactionManagementAsWorkers', params: '?onlyData=true&limit=20', keywords: ['transaction', 'bp transaction', 'approval', 'pending approval'] },
  { name: 'Status Change Requests', path: '/statusChangeRequests', params: '?onlyData=true&limit=20', keywords: ['status change', 'status request'] },

  // ── Organizational Data LOVs ──
  { name: 'Legal Employers', path: '/legalEmployersLov', params: '?onlyData=true&limit=20', keywords: ['legal employer', 'company', 'legal entity'] },
  { name: 'Business Units', path: '/hcmBusinessUnitsLOV', params: '?onlyData=true&limit=20', keywords: ['business unit', 'bu'] },
  { name: 'Countries', path: '/hcmCountriesLov', params: '?onlyData=true&limit=20', keywords: ['country', 'country list'] },
  { name: 'Cost Centers', path: '/hcmCostCentersLOV', params: '?onlyData=true&limit=20', keywords: ['cost center', 'cost centre'] },
  { name: 'Legislative Data Groups', path: '/legislativeDataGroupsLOV', params: '?onlyData=true&limit=20', keywords: ['legislative', 'ldg', 'payroll jurisdiction'] },
  { name: 'Job Families', path: '/jobFamiliesLov', params: '?onlyData=true&limit=20', keywords: ['job family', 'job function'] },
  { name: 'Actions', path: '/actionsLOV', params: '?onlyData=true&limit=20', keywords: ['action', 'hr action', 'change action'] },
  { name: 'Action Reasons', path: '/actionReasonsLOV', params: '?onlyData=true&limit=20', keywords: ['action reason', 'reason for change'] },

  // ── Misc & Config ──
  { name: 'Assignment Statuses', path: '/assignmentStatuses', params: '?onlyData=true&limit=20', keywords: ['assignment status', 'status type', 'worker status'] },
  { name: 'Internet Accounts', path: '/internetAccounts', params: '?onlyData=true&limit=20', keywords: ['internet account', 'social account', 'web account'] },
  { name: 'User Accounts', path: '/userAccounts', params: '?onlyData=true&limit=20', keywords: ['user account', 'login', 'username'] },
  { name: 'Email Migrations', path: '/emailAddrMigrations', params: '?onlyData=true&limit=20', keywords: ['email migration', 'email address change'] },
  { name: 'Document Delivery', path: '/documentDeliveryPreferences', params: '?onlyData=true&limit=20', keywords: ['delivery preference', 'document delivery'] },
  { name: 'Extract Templates', path: '/extractConfiguratorTemplates', params: '?onlyData=true&limit=20', keywords: ['extract', 'template', 'data extract'] },
  { name: 'Workforce Schedules', path: '/workforceScheduleDefinitions', params: '?onlyData=true&limit=20', keywords: ['schedule', 'shift', 'work schedule', 'roster'] },
  { name: 'Incident Kiosks', path: '/incidentKiosks', params: '?onlyData=true&limit=20', keywords: ['incident', 'safety incident', 'workplace incident'] },
  { name: 'Career Interests', path: '/careerInterests', params: '?onlyData=true&limit=20', keywords: ['career interest', 'job interest', 'career preference'] },
  { name: 'Mass Assignments', path: '/massAssignmentChangeDashboard', params: '?onlyData=true&limit=20', keywords: ['mass assignment', 'bulk change', 'mass change'] },
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

const { classifyOracleError } = require('./access-control');
const { detectPersonNumber, detectSelfReference } = require('./person-query-parser');
const { WORKERS_EXPAND, todayDate, flattenWorkerItem } = require('./worker-profile');

let settings = {
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'phi3:mini',
  oracleUrl: '',
  oracleUser: '',
  oraclePass: '',
  alwaysOnTop: true,
};

let currentUserPersonNumber = null; // Set after first worker lookup
let currentUserPersonId = null;
let currentUserDisplayName = null;
// Set when identity resolution was blocked by a permission restriction (403), not
// because the login genuinely has no linked worker record. See detectCurrentUser().
let currentUserRequiresNativeScoping = false;

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
    conversationHistory = await window.savvy.getConversationHistory() || [];
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

// Detect current user by matching the Oracle login username to a person record.
//
// Live-verified: /workers does not support filtering by UserName at all (400 "not
// valid" on every account tested, admin or self-service) - the correct resource is
// /userAccounts, which links Username -> PersonId/PersonNumber. But /userAccounts
// itself requires elevated privileges: a genuine self-service employee login gets 403
// querying it, even for their own record.
//
// Also live-verified: for a real self-service (non-admin) login, calling a resource
// completely UNFILTERED already returns only that person's own records - Oracle's own
// row-level security enforces this natively (an unfiltered /absences call for a
// self-service account returned exactly that person's 5 absences, not everyone's).
// An admin-level account's unfiltered call, by contrast, returns everyone.
//
// So: a 403 on /userAccounts does not mean "not linked to a worker" - it means "this
// is very likely a genuine self-service account, whose own native Oracle security
// already scopes unfiltered queries correctly." Only a clean 200-with-zero-items
// means the login truly has no linked person record.
async function detectCurrentUser() {
  if (!settings.oracleUrl || !settings.oracleUser) return;
  try {
    const url = settings.oracleUrl.replace(/\/+$/, '') + `/hcmRestApi/resources/11.13.18.05/userAccounts?onlyData=true&fields=PersonId,PersonNumber,Username&q=Username='` + encodeURIComponent(settings.oracleUser) + '\'&limit=1';
    const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
    if (result.ok && result.data?.items?.length > 0) {
      const me = result.data.items[0];
      currentUserPersonNumber = me.PersonNumber;
      currentUserPersonId = me.PersonId;
      console.log('[Savvy] Current user detected: #', currentUserPersonNumber);
    } else if (result.status === 403) {
      currentUserRequiresNativeScoping = true;
      console.log('[Savvy] Cannot resolve identity directly (403 on userAccounts) — likely a self-service account. "My" queries will rely on Oracle\'s own native security to scope unfiltered results.');
    } else {
      console.log('[Savvy] No account/person link found for this login — "my" queries will ask for a specific person instead.');
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
    return { type: 'text', text: '[INFO] No specific data matched. Try asking about employees, absences, departments, jobs, grades, time, payroll, benefits, goals, learning, recruiting, etc.' };
  }

  // Step 2: Detect Person Number (alphanumeric like NM290, or pure numeric) — must run
  // against the ORIGINAL message (not the lowercased `msg`), since alphanumeric codes
  // carry meaningful uppercase letters, and must not require the literal word "number".
  const personNumber = detectPersonNumber(userMessage);

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

  // Step 1: Detect "my" context — use stored current user. Only applies when no
  // explicit person number/name was already found above — an explicit reference in
  // the message always wins over generic conversational phrasing like "show me...",
  // which is not actually a self-reference just because it contains the word "me".
  const isMyQuery = !personNumber && !personName && detectSelfReference(userMessage);
  if (isMyQuery && currentUserPersonNumber) {
    return await fetchDataForPerson({
      personNumber: currentUserPersonNumber,
      personId: currentUserPersonId,
      displayName: currentUserDisplayName || 'You',
    }, endpoints);
  }
  if (isMyQuery && currentUserRequiresNativeScoping) {
    // Couldn't resolve identity directly (403 on userAccounts — a permission
    // restriction, not "no data"). Live-verified: for a genuine self-service account,
    // Oracle's own row-level security already scopes an unfiltered fetch to just that
    // person's own records, so pass person=null and trust Oracle rather than
    // incorrectly refusing "my" queries just because we couldn't pre-resolve who's
    // asking. This would be wrong for an admin-level account (which sees everyone
    // unfiltered) — but an admin-level account resolves via userAccounts directly and
    // never reaches this branch in the first place.
    return await fetchDataForPerson(null, endpoints);
  }
  if (isMyQuery && !currentUserPersonNumber) {
    // Never silently fall through to an unfiltered "everyone's data" fetch when the
    // user asked for "my" data — this login isn't linked to a specific employee
    // record in the system (e.g. an admin/integration account), so say so plainly
    // instead of showing data that looks like theirs but isn't.
    return { type: 'no-data', text: "This login isn't linked to a specific employee record in the system, so I can't show \"your\" data. Try asking about a specific person by name or employee number instead." };
  }

  // Step 3: Resolve person — either by number or by name search
  let resolvedPersons = [];

  if (personNumber) {
    // Direct lookup by PersonNumber
    try {
      const url = settings.oracleUrl.replace(/\/+$/, '') + `/hcmRestApi/resources/11.13.18.05/workers?onlyData=true&${WORKERS_EXPAND}&effectiveDate=${todayDate()}&q=PersonNumber='` + encodeURIComponent(personNumber) + '\'&limit=5';
      console.log('[Renderer] Resolving person:', personNumber, url);
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      console.log('[Renderer] Resolve result: ok=' + result.ok, 'status=' + result.status, 'items=' + (result.data?.items?.length || 0));
      if (result.ok && result.data?.items?.length > 0) {
        resolvedPersons = result.data.items.map(flattenWorkerItem).map(p => ({
          personNumber: p.PersonNumber,
          personId: p.PersonId,
          displayName: p.DisplayName || ((p.FirstName || '') + ' ' + (p.LastName || '')).trim(),
          department: p.DepartmentName || '',
          job: p.JobTitle || '',
        }));
      }
    } catch {}
  } else if (personName) {
    // Search by name
    try {
      const url = settings.oracleUrl.replace(/\/+$/, '') + `/hcmRestApi/resources/11.13.18.05/workers?onlyData=true&${WORKERS_EXPAND}&effectiveDate=${todayDate()}&q=DisplayName LIKE '%25` + encodeURIComponent(personName) + '%25\'&sortBy=DisplayName:asc&limit=10';
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      if (result.ok && result.data?.items?.length > 0) {
        resolvedPersons = result.data.items.map(flattenWorkerItem).map(p => ({
          personNumber: p.PersonNumber,
          personId: p.PersonId,
          displayName: p.DisplayName || ((p.FirstName || '') + ' ' + (p.LastName || '')).trim(),
          department: p.DepartmentName || '',
          job: p.JobTitle || '',
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

const { isPersonScoped } = require('./endpoint-scoping');

async function fetchDataForPerson(person, endpoints) {
  const results = [];
  const scopedEndpoints = person ? endpoints.filter((ep) => isPersonScoped(ep.path)) : endpoints;
  for (const ep of scopedEndpoints) {
    try {
      // effectiveDate=today on every fetch so date-tracked (effective-dated) Oracle
      // records - assignments, absences, salaries, etc. - always reflect the current
      // date rather than relying on Oracle's implicit default context.
      let url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05' + ep.path + ep.params + `&effectiveDate=${todayDate()}`;
      if (person) {
        // Some resources (e.g. /payslips) filter by the numeric PersonId rather than
        // the string PersonNumber business key, and take it unquoted since it's a
        // number, not a string. Verified live per-resource — see personFilterField
        // comment on the HCM_ENDPOINTS entries above.
        if (ep.personFilterUsesPersonId) {
          if (person.personId === undefined || person.personId === null) {
            results.push(`[NO ACCESS — ${ep.name}] Can't look this up without an internal person reference for ${person.displayName || 'this person'}.`);
            continue;
          }
          url += `&q=${ep.personFilterField || 'PersonId'}=${person.personId}`;
        } else {
          const filterField = ep.personFilterField || 'PersonNumber';
          url += `&q=${filterField}='` + encodeURIComponent(person.personNumber) + '\'';
        }
      }
      console.log('[Renderer] Fetching:', ep.name, url);
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      console.log('[Renderer] Result:', ep.name, 'ok=' + result.ok, 'status=' + result.status, 'items=' + (result.data?.items?.length || 0));
      if (!result.ok) {
        if (classifyOracleError(result.status) === 'hard-stop') {
          return { type: 'access-denied', text: 'Authentication failed. Please check your Oracle credentials in Settings.' };
        }
        // soft-skip: record and move on to the next endpoint rather than discarding
        // everything already fetched in this batch.
        const who = person ? ' for ' + person.displayName : '';
        const reason = result.status === 403
          ? 'You do not have permission to view ' + ep.name.toLowerCase() + who + '.'
          : 'HTTP ' + result.status + ' ' + (result.statusText || '');
        results.push(`[NO ACCESS — ${ep.name}] ${reason}`);
        continue;
      }
      const rawItems = result.data?.items || [];
      const items = ep.path === '/workers' ? rawItems.map(flattenWorkerItem) : rawItems;
      const label = person ? ep.name + ' for ' + person.displayName : ep.name;
      if (items.length > 0) {
        results.push(`[ORACLE DATA — ${label}] ${items.length} records found:`);
        items.slice(0, 10).forEach((item, i) => {
          results.push(`  ${i + 1}. ${formatItem(ep.path, item)}`);
        });
        // Include full raw field data only when a specific person was resolved — that's
        // the only case where the LLM needs record-level detail to answer a specific
        // question (e.g. "what is their department"). For generic multi-record listings,
        // the formatted card above is the answer; dumping raw JSON for many records
        // risks a small local model echoing a fragment of it back verbatim.
        if (person) {
          results.push(`[FULL DATA — ${label}]:`);
          items.slice(0, 10).forEach((item, i) => {
            const clean = {};
            for (const [k, v] of Object.entries(item)) {
              if (!k.startsWith('_') && typeof v !== 'object' && v !== null && v !== '') clean[k] = v;
            }
            results.push(`  ${i + 1}. ${JSON.stringify(clean)}`);
          });
        }
        // hasMore means Oracle has more records beyond this page — carry the exact
        // next-page URL (offset advanced by what we already have) so a "Load more"
        // button can fetch it on demand instead of blocking here to fetch everything
        // up front, which risks a very long wait for large/unfiltered result sets.
        const nextUrl = result.data?.hasMore ? `${url}&offset=${items.length}` : null;
        results.push(`__HTML__${label}__${ep.path}__${items.length}__${JSON.stringify({ items, nextUrl })}`);
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

const FORMATTERS = {
  '/workers': (w) => {
    const name = w.DisplayName || ((w.FirstName || '') + ' ' + (w.LastName || '')).trim() || 'N/A';
    const dept = w.DepartmentName || '';
    const job = w.JobTitle || '';
    const status = w.EmploymentStatus || '';
    return `Name: ${name}${dept ? ' | Dept: ' + dept : ''}${job ? ' | Job: ' + job : ''}${status ? ' | Status: ' + status : ''}`;
  },
  '/absences': (a) => `Type: ${a.AbsenceType || a.AbsenceTypeName || 'N/A'} | From: ${a.StartDate || 'N/A'} | To: ${a.EndDate || 'N/A'} | Days: ${a.AbsenceDays || a.Duration || 'N/A'} | Status: ${a.AbsenceStatus || a.ApprovalStatus || 'N/A'}`,
  '/organizations': (d) => `Name: ${d.Name || d.OrganizationName || 'N/A'} | Manager: ${d.ManagerName || ''} | Location: ${d.LocationName || ''}`,
  '/locations': (l) => `Name: ${l.Name || 'N/A'} | City: ${l.City || ''} | Country: ${l.Country || ''}`,
  '/jobs': (j) => `Name: ${j.Name || 'N/A'} | Family: ${j.JobFamilyName || ''} | Level: ${j.JobLevel || ''}`,
  '/positions': (p) => `Name: ${p.Name || 'N/A'} | Dept: ${p.DepartmentName || ''} | Job: ${p.JobName || ''}`,
  '/grades': (g) => `Name: ${g.Name || 'N/A'} | Ladder: ${g.GradeLadderName || ''}`,
  '/timeRecords': (t) => `Employee: ${t.EmployeeName || t.WorkerName || 'N/A'} | Hours: ${t.TotalRegHours || t.Hours || 'N/A'} | Status: ${t.StatusCode || t.Status || ''}`,
  '/payrollRelationships': (p) => `Payroll relationship since: ${p.StartDate || 'N/A'} | Country: ${p.Country || ''}`,
  '/salaries': (s) => `Amount: ${s.SalaryAmount != null ? s.SalaryAmount + ' ' + (s.CurrencyCode || '') : 'N/A'} | From: ${s.DateFrom || 'N/A'} | Action: ${s.ActionName || ''}`,
  '/allocatedChecklists': (c) => `Name: ${c.ChecklistName || 'N/A'} | Status: ${c.Status || ''} | Due: ${c.DueDate || ''}`,
  '/areasOfResponsibility': (r) => `Type: ${r.ResponsibilityType || 'N/A'} | Person: ${r.PersonName || ''}`,
  '/assignmentStatuses': (s) => `Name: ${s.Name || 'N/A'}`,
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

const { pickDisplayLabel } = require('./name-resolver');

// Renders one row of a data list. Always prefers the endpoint-specific formatter in
// HTML_FORMATTERS (which knows the real, relevant fields for that record type — an
// absence's type and dates, a department's name, etc.) over the generic name-lookup
// fallback, so the card actually shows information relevant to what was asked for
// instead of a placeholder that only makes sense for people.
function formatItemAsHTML(path, item, idx, epName) {
  const formatter = HTML_FORMATTERS[path];
  if (formatter) return formatter(item, idx);
  // epName may already be "Payroll Relationships for Jane Smith" (the header label) -
  // strip the " for X" suffix so the per-row fallback doesn't repeat the person's name.
  const baseName = epName ? epName.replace(/ for .+$/, '') : '';
  const label = pickDisplayLabel(item) || (baseName ? `${baseName.replace(/s$/, '')} record` : 'Record');
  return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(label)}</b></span></div>`;
}

// Whitelisted personal/employment fields for the friendly single-person profile
// view. Deliberately a whitelist, not a blacklist — this is the only way to
// guarantee an internal ID field can never slip through, since a blacklist would
// only be as good as the list of ID-shaped patterns someone remembered to exclude.
const PERSON_PROFILE_FIELDS = [
  { key: 'EmailAddress', label: 'Email', section: 'personal' },
  { key: 'PhoneNumber', label: 'Phone', section: 'personal' },
  { key: 'DateOfBirth', label: 'Birthday', section: 'personal', isDate: true },
  { key: 'JobTitle', label: 'Job title', section: 'employment' },
  { key: 'DepartmentName', label: 'Department', section: 'employment' },
  { key: 'BusinessUnitName', label: 'Company', section: 'employment' },
  { key: 'StartDate', label: 'Started on', section: 'employment', isDate: true },
  { key: 'EmploymentStatus', label: 'Status', section: 'employment' },
  { key: 'EmploymentType', label: 'Employment type', section: 'employment' },
];

function buildPersonProfileHTML(item) {
  const name = pickDisplayLabel(item) || 'Team member';
  const personalRows = [];
  const employmentRows = [];
  for (const field of PERSON_PROFILE_FIELDS) {
    const raw = item[field.key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = field.isDate ? formatDate(raw) : escapeHtml(String(raw));
    const row = `<div class="data-row"><span class="data-field-label">${escapeHtml(field.label)}</span><span class="data-field">${value}</span></div>`;
    (field.section === 'personal' ? personalRows : employmentRows).push(row);
  }
  // PersonNumber is a business employee code, not an internal surrogate key like
  // PersonId - shown here so the profile card can actually answer "what's their
  // person number" instead of forcing the user to hunt for it elsewhere.
  const personNumber = item.PersonNumber ? ` <span style="color:#94a3b8;font-weight:400;">(${escapeHtml(item.PersonNumber)})</span>` : '';
  let html = `<div class="data-section"><div class="data-header"><span class="data-icon">&#9679;</span> <b>${escapeHtml(name)}</b>${personNumber}</div>`;
  if (personalRows.length) html += `<div class="data-subheader">Personal details</div>${personalRows.join('')}`;
  if (employmentRows.length) html += `<div class="data-subheader">Work details</div>${employmentRows.join('')}`;
  if (!personalRows.length && !employmentRows.length) html += `<div class="data-row">No additional details are available for this person.</div>`;
  html += '</div>';
  return html;
}

// Shows a friendly one-person profile card when exactly one Workers record is
// being displayed, and the plain numbered list for everything else (multi-record
// lists, other endpoint types).
function renderDataBlock(epName, epPath, items, nextUrl) {
  if (epPath === '/workers' && items.length === 1) {
    return buildPersonProfileHTML(items[0]);
  }
  return buildFormattedList(epName, epPath, items, 10, false, nextUrl);
}

const HTML_FORMATTERS = {
  '/absenceTypesLOV': (t, idx) => {
    const name = t.AbsenceTypeName || t.absenceTypeName || t.Name || t.name || '';
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(name || '—')}</b></span></div>`;
  },
  '/workers': (w, idx) => {
    const name = pickDisplayLabel(w) || 'Team member';
    // PersonNumber is a business employee code (e.g. "NM1658"), not a sensitive
    // internal surrogate key like PersonId - showing it is what lets someone actually
    // look this person up again, so it's shown deliberately, unlike PersonId/
    // AssignmentId/PayrollRelationshipId etc. which never appear anywhere in the UI.
    const personNumber = w.PersonNumber ? ` <span class="data-field" style="color:#94a3b8;">(${escapeHtml(w.PersonNumber)})</span>` : '';
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(name)}</b></span>${personNumber}</div>`;
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
  '/payslips': (p, idx) => {
    const amount = p.Amount != null ? `${p.Amount} ${p.CurrencyCode || ''}`.trim() : 'Payslip';
    const date = p.PaymentDate || '';
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(amount)}</b></span> <span class="data-field">${formatDate(date)}</span></div>`;
  },
  '/salaries': (s, idx) => {
    const amount = s.SalaryAmount != null ? `${s.SalaryAmount.toLocaleString()} ${s.CurrencyCode || ''}`.trim() : 'Salary';
    const freq = s.FrequencyName ? ` / ${s.FrequencyName.toLowerCase()}` : '';
    const detailParts = [];
    if (s.DateFrom) detailParts.push(`from ${formatDate(s.DateFrom)}`);
    if (s.ActionName) detailParts.push(s.ActionName);
    const detail = detailParts.join(' — ');
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(amount + freq)}</b></span>${detail ? ` <span class="data-field">${escapeHtml(detail)}</span>` : ''}</div>`;
  },
  '/payrollRelationships': (p, idx) => {
    const label = p.StartDate ? `Payroll relationship since ${formatDate(p.StartDate)}` : 'Payroll relationship';
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(label)}</b></span>${p.Country ? ` <span class="data-field">${escapeHtml(p.Country)}</span>` : ''}</div>`;
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

function loadMoreButtonHTML(nextUrl, epPath, epName) {
  if (!nextUrl) return '';
  return `<button class="load-more-btn read-btn" data-next-url="${escapeHtml(nextUrl)}" data-ep-path="${escapeHtml(epPath)}" data-ep-name="${escapeHtml(epName)}" style="width:100%;margin-top:6px;font-size:11px;padding:6px;">Load more</button>`;
}

// Shows every record actually fetched in this page (no display-level truncation
// beyond what was already paid for in the round trip) plus a real "Load more" button
// when Oracle reported more records exist beyond this page (nextUrl) - clicking it
// fetches the next page on demand rather than blocking here to fetch everything
// up front.
function buildFormattedList(epName, epPath, items, maxShow = 10, isTypeList = false, nextUrl = null) {
  const total = items.length;

  // Type lists: show as simple bullet list, not numbered rows
  if (isTypeList) {
    let html = `<div class="data-section"><div class="data-header"><span class="data-icon">&#9679;</span> <b>${escapeHtml(epName)}</b> — ${total} available</div>`;
    html += '<div style="padding:4px 8px;">';
    for (let i = 0; i < total; i++) {
      const name = items[i].AbsenceTypeName || items[i].absenceTypeName || items[i].Name || items[i].name || `${epName.replace(/s$/, '')} type`;
      html += `<div style="padding:3px 0;font-size:12px;">&#8226; <b>${escapeHtml(name)}</b></div>`;
    }
    const hint = SUGGESTIONS[epPath];
    if (hint) html += `<div class="data-more" style="color:#818cf8;margin-top:4px;">${escapeHtml(hint)}</div>`;
    html += loadMoreButtonHTML(nextUrl, epPath, epName);
    html += '</div></div>';
    return html;
  }

  // Regular records: show as numbered rows
  let html = `<div class="data-section"><div class="data-header"><span class="data-icon">&#9679;</span> <b>${escapeHtml(epName)}</b> — ${total} record${total !== 1 ? 's' : ''}${nextUrl ? '+' : ''}</div>`;
  for (let i = 0; i < total; i++) {
    html += formatItemAsHTML(epPath, items[i], i + 1, epName);
  }
  const hint = SUGGESTIONS[epPath];
  if (hint) html += `<div class="data-more" style="color:#818cf8;margin-top:4px;">${escapeHtml(hint)}</div>`;
  html += loadMoreButtonHTML(nextUrl, epPath, epName);
  html += '</div>';
  return html;
}

// ── Chat ──
let pageContext = '';
let pageCursorRegion = null;

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
9. NEVER output raw JSON, curly braces, or anything that looks like code. If you catch yourself about to write "{", stop and rephrase the same information as a short sentence or bullet point instead.
10. NEVER show an internal system ID (PersonId, AssignmentId, PayrollRelationshipId, or any long numeric surrogate key) anywhere in your response - those are meaningless database keys, not something a person would recognize. A person's Person Number (a short code like "NM1658") is different - it's their actual business employee code, and you should state it plainly if asked "what is their person number" or similar, using the exact value provided. If a name is not available, say "this person" instead of showing an internal ID.
11. Use the full data provided to answer specific questions (department, job, location, etc.).
12. Write for someone with zero technical background - plain, everyday words only. No field names, no technical terms, no jargon. Explain things the way you'd explain them to a curious child: simply and warmly.
13. Keep each person's/record's facts strictly separate. Never blend a detail from one data block with a name or record from a different block, and never let a system field like CreatedBy or LastUpdatedBy (an audit trail of who touched the record, not who it's about) be mistaken for the actual person the record is about.
14. Conversation history is context, not a license to improvise. If an earlier turn mentioned a person, only reuse that identity for a follow-up ("his", "her", "their", "that person") if it's genuinely unambiguous from the immediately preceding exchange. If it's been several turns, the topic has shifted, or more than one person was discussed, do not guess who a pronoun refers to - ask "Which person do you mean - by name or employee number?" instead of picking one.
15. If the data needed to answer isn't in front of you - not fetched, not in this conversation, not in [HCM KNOWLEDGE] - say plainly that you don't have that information right now. A confident-sounding guess is a worse answer than an honest "I don't have that on file."
16. Before answering, silently check: is every specific fact I'm about to state (a name, a date, an amount, a status) traceable to a block actually shown above? If any single fact fails that check, cut it or replace it with "I don't have that on file" - do not soften a fabrication into "maybe" or "it looks like" instead of removing it.`;

  let fullMsg = msg;

  if (pageContext) {
    // Refresh the cursor position at chat time, not just when the screenshot was
    // taken — the user may have moved the mouse since then, and a navigation
    // question ("where do I click for X") needs their current position.
    let cursorNote = '';
    try {
      const cursor = await window.savvy.getCursorContext();
      pageCursorRegion = cursor.region;
      cursorNote = `\n[CURSOR] Currently in the ${pageCursorRegion} area of the screen.`;
    } catch {}
    fullMsg = '[CURRENT ORACLE PAGE]\n' + pageContext.substring(0, 2000) + cursorNote + '\n\n' + fullMsg;
  }

  // Auto-fetch real data from Oracle HCM based on user intent
  const fetchedData = await autoFetchData(msg);

  // Handle choose-person: show selection buttons
  if (fetchedData.type === 'choose-person') {
    const container = document.getElementById('messages');
    const chooseDiv = document.createElement('div');
    chooseDiv.className = 'msg bot';
    let buttonsHtml = fetchedData.persons.map((p, i) =>
      `<button class="person-select-btn" data-pn="${escapeHtml(p.personNumber)}" data-pid="${escapeHtml(p.personId ?? '')}" data-name="${escapeHtml(p.displayName)}" data-eps="${escapeHtml(JSON.stringify(fetchedData.endpoints.map(e => e.path)))}" style="display:block;width:100%;text-align:left;padding:8px 12px;margin:4px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;font-size:12px;border-left:3px solid #0070F3;">
        <b>${escapeHtml(p.displayName)}</b>${p.department ? ' &middot; ' + escapeHtml(p.department) : ''}${p.job ? ' &middot; ' + escapeHtml(p.job) : ''}
      </button>`
    ).join('');
    chooseDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text"><div style="margin-bottom:6px;">${escapeHtml(fetchedData.text)}</div>${buttonsHtml}</div>`;
    container.appendChild(chooseDiv);
    container.scrollTop = container.scrollHeight;

    // Attach click handlers
    chooseDiv.querySelectorAll('.person-select-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pn = btn.dataset.pn;
        const pid = btn.dataset.pid ? Number(btn.dataset.pid) : undefined;
        const name = btn.dataset.name;
        const eps = JSON.parse(btn.dataset.eps);
        btn.disabled = true;
        btn.style.opacity = '0.5';
        const epDefs = eps.map(p => HCM_ENDPOINTS.find(e => e.path === p)).filter(Boolean);
        const person = { personNumber: pn, personId: pid, displayName: name };
        const result = await fetchDataForPerson(person, epDefs);
        if (result.type === 'data' && result.text) {
          // Show the data
          const htmlLines = result.text.split('\n').filter(l => l.startsWith('__HTML__'));
          let html = '';
          for (const line of htmlLines) {
            const parts = line.split('__');
            try {
              const payload = JSON.parse(parts.slice(5).join('__'));
              html += renderDataBlock(parts[2], parts[3], payload.items, payload.nextUrl);
            } catch {}
          }
          // Show the real fetched data card only — no LLM prose on top of it, for the
          // same reason as the main sendMessage flow: a small local model has been
          // directly observed inventing details not present in the actual record.
          if (html) {
            const dataDiv = document.createElement('div');
            dataDiv.className = 'msg bot';
            dataDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text">${html}</div>`;
            container.appendChild(dataDiv);
          }
          const note = 'Everything shown above is on file in the system — nothing more is available right now.';
          addMessage(note, 'bot');
          conversationHistory.push({ role: 'user', content: `Selected: ${name} (#${pn})`, timestamp: Date.now() });
          conversationHistory.push({ role: 'bot', content: note, timestamp: Date.now() });
          try { await window.savvy.saveConversationHistory(conversationHistory.slice(-100)); } catch {}
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

  // Handle text (no endpoint keyword matched at all — e.g. "Show my details" isn't
  // recognized because "details" isn't a keyword for any endpoint). Show the
  // deterministic message directly rather than handing it to the LLM as "context" —
  // with nothing real to ground it, it doesn't say "I don't know", it invents a
  // plausible-sounding but entirely fabricated explanation (observed live: an
  // authoritative-looking GDPR/privacy-policy refusal that was pure fiction).
  if (fetchedData.type === 'text') {
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

  // Handle a data-fetch that ran but produced no actual record — every queried
  // endpoint either found zero records or was denied. Same reasoning as the
  // no-data/text handlers above: show what's actually known plainly instead of
  // handing bare status lines ("No records found.", "[NO ACCESS]") to the LLM as
  // free-form "context" — observed live, a small local model doesn't relay that
  // honestly, it invents a plausible-sounding but fabricated permissions/privacy
  // refusal instead (e.g. for "Show my employment details" against a real
  // self-service account whose employee-list query simply found nothing).
  if (fetchedData.type === 'data' && fetchedData.results && !fetchedData.text.includes('__HTML__')) {
    const friendly = fetchedData.results
      .map(line => line
        .replace(/^\[NO ACCESS — [^\]]+\]\s*/, '')
        .replace(/^\[ORACLE DATA — ([^\]]+)\]\s*No records found\.$/, 'No $1 information was found on file.')
        .replace(/^\[ERROR — [^\]]+\]\s*/, 'Something went wrong looking that up: '))
      .join(' ');
    addMessage(friendly || "I couldn't find anything on file for that right now.", 'bot');
    conversationHistory.push({ role: 'user', content: msg, timestamp: Date.now() });
    conversationHistory.push({ role: 'bot', content: friendly, timestamp: Date.now() });
    try { await window.savvy.saveConversationHistory(conversationHistory.slice(-100)); } catch {}
    return;
  }

  // Handle data
  let htmlSections = '';
  if (fetchedData && fetchedData.text) {
    const htmlLines = fetchedData.text.split('\n').filter(l => l.startsWith('__HTML__'));
    for (const line of htmlLines) {
      const parts = line.split('__');
      try {
        const payload = JSON.parse(parts.slice(5).join('__'));
        htmlSections += renderDataBlock(parts[2], parts[3], payload.items, payload.nextUrl);
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

  const kb = findKnowledge(msg);
  if (kb) {
    fullMsg = '[HCM KNOWLEDGE]\n' + kb + '\n\n' + fullMsg;
  }

  // Build messages with conversation history for context
  const recentHistory = conversationHistory.slice(-20).map(h => ({
    role: h.role === 'bot' ? 'assistant' : 'user',
    content: h.content,
  }));
  const messages = [
    { role: 'system', content: sysPrompt },
    ...recentHistory,
    { role: 'user', content: fullMsg }
  ];

  // Show the formatted data card whenever any real Oracle data was fetched, and stop
  // there — do NOT ask the LLM to add free-form prose on top of it. Every card is
  // built directly from whitelisted real fields (renderDataBlock / HTML_FORMATTERS /
  // buildPersonProfileHTML) and can never contain anything not actually in the
  // system. This was verified against a real Oracle tenant: a small local model
  // reliably invents plausible-sounding names, departments, dates, and even fake
  // record IDs when asked to narrate real fetched data in prose, no matter how the
  // system prompt is worded. The card is the complete, trustworthy answer on its
  // own. The LLM is only ever consulted below when NO data card was produced —
  // general HCM knowledge questions, or a "no records found" result — where there
  // is no specific fetched data it could misrepresent.
  const container = document.getElementById('messages');
  if (htmlSections) {
    const dataDiv = document.createElement('div');
    dataDiv.className = 'msg bot';
    dataDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text">${htmlSections}</div>`;
    container.appendChild(dataDiv);
    container.scrollTop = container.scrollHeight;

    const note = 'Everything shown above is on file in the system — nothing more is available right now.';
    addMessage(note, 'bot');
    conversationHistory.push({ role: 'user', content: msg, timestamp: Date.now() });
    conversationHistory.push({ role: 'bot', content: note, timestamp: Date.now() });
    try { await window.savvy.saveConversationHistory(conversationHistory.slice(-100)); } catch {}
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
  try { await window.savvy.saveConversationHistory(conversationHistory.slice(-100)); } catch {}
}

const HCM_ENDPOINTS = [
  // ── Core HR & Workforce ──
  { name: 'Workers', path: '/workers', params: `?onlyData=true&limit=20&${WORKERS_EXPAND}`, keywords: ['employee', 'worker', 'person', 'team', 'headcount', 'hire', 'name', 'number'] },
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
  // personFilterField: Oracle's query-filter attribute names are case-sensitive and
  // inconsistent across resources — /workers uses PascalCase (PersonNumber), but
  // /absences' actual response fields are camelCase (personNumber), confirmed live
  // against a real tenant (PascalCase gets rejected with a 400 "not valid" error on
  // this resource specifically). Defaults to 'PersonNumber' for entries that don't
  // override it — those are unverified against a real tenant and may need the same
  // treatment if they turn out to need camelCase too.
  { name: 'Absences', path: '/absences', params: '?onlyData=true&limit=20', personFilterField: 'personNumber', keywords: ['absence', 'leave', 'time off', 'vacation', 'sick', 'absence record', 'leave record', 'my absences', 'leave history'] },
  { name: 'Absence Types', path: '/absenceTypesLOV', params: '?onlyData=true&limit=50', keywords: ['absence type', 'leave type', 'absence category', 'types of absence', 'types of leave'], isTypeList: true },
  { name: 'Absence Plans', path: '/absencePlansLOV', params: '?onlyData=true&limit=50', keywords: ['absence plan', 'leave plan', 'entitlement'] },
  { name: 'Absence Calendars', path: '/absenceCalendars', params: '?onlyData=true&limit=20', keywords: ['absence calendar', 'leave calendar', 'org calendar'] },
  { name: 'Absence No Entitlements', path: '/absenceNoEntitlements', params: '?onlyData=true&limit=20', personFilterField: 'PersonId', personFilterUsesPersonId: true, keywords: ['absence no entitlement', 'no entitlement'] },

  // ── Payroll ──
  { name: 'Payroll Relationships', path: '/payrollRelationships', params: '?onlyData=true&limit=20', keywords: ['payroll', 'salary', 'pay', 'wage', 'earnings'] },
  { name: 'Element Entries', path: '/elementEntries', params: '?onlyData=true&limit=20', keywords: ['element entry', 'pay element', 'earning', 'deduction'] },
  { name: 'Calculation Entries', path: '/calculationEntries', params: '?onlyData=true&limit=20', personFilterField: 'PersonId', personFilterUsesPersonId: true, keywords: ['calculation', 'calc card', 'payroll calculation'] },
  { name: 'Flow Instances', path: '/flowInstances', params: '?onlyData=true&limit=20', keywords: ['flow instance', 'payroll flow', 'payroll run'] },
  { name: 'Flow Patterns', path: '/flowPatterns', params: '?onlyData=true&limit=20', keywords: ['flow pattern', 'payroll process'] },
  { name: 'Pay Advances', path: '/payAdvances', params: '?onlyData=true&limit=20', keywords: ['pay advance', 'salary advance', 'advance request'] },
  { name: 'Plan Balances', path: '/planBalances', params: '?onlyData=true&limit=20', keywords: ['plan balance', 'balance', 'pay balance'] },
  // Payslips filter by the numeric PersonId, unquoted (confirmed via Oracle's REST
  // docs and live-verified against a real tenant — query mechanics work correctly
  // even when the tenant has zero processed payroll runs to return).
  { name: 'Payslips', path: '/payslips', params: '?onlyData=true&limit=10&orderBy=PaymentDate:desc', personFilterField: 'PersonId', personFilterUsesPersonId: true, keywords: ['payslip', 'pay slip', 'pay stub', 'paycheck', 'payment history', 'net pay'] },

  // ── Benefits ──
  { name: 'Benefit Enrollments', path: '/benefitEnrollments', params: '?onlyData=true&limit=20', personFilterField: 'PersonId', personFilterUsesPersonId: true, keywords: ['benefit enrollment', 'benefit', 'enrollment'] },
  { name: 'Benefit Groups', path: '/benefitGroups', params: '?onlyData=true&limit=20', keywords: ['benefit group', 'benefit plan group'] },
  { name: 'Benefit Opportunities', path: '/benefitEnrollmentOpportunities', params: '?onlyData=true&limit=20', keywords: ['benefit opportunity', 'enrollment opportunity'] },
  { name: 'Benefit Year Periods', path: '/benefitYearPeriods', params: '?onlyData=true&limit=20', keywords: ['benefit year', 'benefit period'] },
  { name: 'Benefits Comparison', path: '/benefitPlansComparison', params: '?onlyData=true&limit=20', keywords: ['compare benefits', 'benefit comparison'] },

  // ── Compensation ──
  { name: 'Salaries', path: '/salaries', params: '?onlyData=true&limit=20', personFilterField: 'PersonId', personFilterUsesPersonId: true, keywords: ['salary', 'compensation', 'pay rate', 'annual salary'] },
  { name: 'Salary Basis', path: '/salaryBasisLov', params: '?onlyData=true&limit=20', keywords: ['salary basis', 'pay basis'] },
  { name: 'Grade Rates', path: '/gradeRates', params: '?onlyData=true&limit=20', keywords: ['grade rate', 'pay grade', 'salary grade'] },
  { name: 'Grades', path: '/grades', params: '?onlyData=true&limit=20', keywords: ['grade', 'level', 'band', 'job grade'] },
  { name: 'Grade Ladders', path: '/gradeLadders', params: '?onlyData=true&limit=20', keywords: ['grade ladder', 'career ladder', 'progression'] },
  { name: 'Compensation Percentiles', path: '/compensationPeerSalaryPercentiles', params: '?onlyData=true&limit=20', keywords: ['percentile', 'compa-ratio', 'market position'] },
  { name: 'Stock Profiles', path: '/compensationStockProfiles', params: '?onlyData=true&limit=20', keywords: ['stock', 'equity', 'stock profile'] },

  // ── Time & Labor ──
  { name: 'Time Records', path: '/timeRecords', params: '?onlyData=true&limit=20', personFilterField: 'personNumber', keywords: ['time record', 'time card', 'timesheet', 'hours worked'] },
  { name: 'Time Record Groups', path: '/timeRecordGroups', params: '?onlyData=true&limit=20', personFilterField: 'personNumber', keywords: ['time group', 'time entry group'] },
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
  { name: 'Worker Journeys', path: '/workerJourneys', params: '?onlyData=true&limit=20', personFilterField: 'PersonId', personFilterUsesPersonId: true, keywords: ['worker journey', 'my journey', 'assigned journey'] },
  { name: 'Worker Journey Tasks', path: '/workerJourneyTasks', params: '?onlyData=true&limit=20', keywords: ['journey task', 'onboarding task', 'offboarding task'] },
  { name: 'Journey Allocations', path: '/journeyAllocations', params: '?onlyData=true&limit=20', keywords: ['journey allocation', 'journey assignment'] },
  { name: 'Journey Counts', path: '/journeyCounts', params: '?onlyData=true&limit=20', keywords: ['journey count', 'journey summary'] },

  // ── Recruiting ──
  { name: 'Job Requisitions', path: '/recruitingJobRequisitions', params: '?onlyData=true&limit=20', keywords: ['requisition', 'job req', 'open position', 'hiring'] },
  { name: 'Job Applications', path: '/recruitingJobApplications', params: '?onlyData=true&limit=20', personFilterField: 'CandidatePersonId', personFilterUsesPersonId: true, keywords: ['job application', 'applicant', 'application'] },
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
  { name: 'Communications', path: '/communicateUIMyCommunications', params: '?onlyData=true&limit=20', personFilterField: 'PersonId', personFilterUsesPersonId: true, keywords: ['communication', 'message', 'announcement', 'notification'] },
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
  { name: 'Career Interests', path: '/careerInterests', params: '?onlyData=true&limit=20', personFilterField: 'PersonId', personFilterUsesPersonId: true, keywords: ['career interest', 'job interest', 'career preference'] },
  { name: 'Mass Assignments', path: '/massAssignmentChangeDashboard', params: '?onlyData=true&limit=20', keywords: ['mass assignment', 'bulk change', 'mass change'] },
];

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
      let cursorNote = '';
      try {
        const cursor = await window.savvy.getCursorContext();
        pageCursorRegion = cursor.region;
        cursorNote = `\n\nThe user's mouse cursor is currently in the ${cursor.region} area of their screen (note: this is relative to the whole screen, not necessarily this window — use it only for coarse directional guidance, e.g. "move down and to the left", never for exact pixel positions).`;
      } catch { pageCursorRegion = null; }

      const visionPrompt = `Analyze this Oracle Fusion HCM screenshot. List:
1. Page title and module (e.g., "My Team", "Absences", "Payroll")
2. All visible field labels and their values
3. All buttons and links with their labels, and roughly where each sits on screen (top/bottom, left/right)
4. Any tables: list column headers and first 3 rows of data
5. Any alerts, errors, or notifications
6. Navigation breadcrumbs or menu path

Be thorough and specific. Use actual text from the screenshot. If asked later for navigation help, use the on-screen positions you noted here plus the user's cursor location to give simple directions like "move up and to the right toward the Absences tab" — never invent a location you didn't actually see.${cursorNote}`;

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

  // Chat
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
  });

  // "Load more" — delegated on #messages since cards (and their buttons) are added
  // dynamically after every chat response. Fetches the next page on demand instead of
  // blocking the original response to fetch everything up front, which risks a very
  // long wait for large or unfiltered result sets.
  document.getElementById('messages').addEventListener('click', async (e) => {
    const btn = e.target.closest('.load-more-btn');
    if (!btn) return;
    const nextUrl = btn.dataset.nextUrl;
    const epPath = btn.dataset.epPath;
    const epName = btn.dataset.epName;
    btn.disabled = true;
    btn.textContent = 'Loading...';
    try {
      const result = await window.savvy.oracleApi(nextUrl, settings.oracleUser, settings.oraclePass);
      if (!result.ok) {
        btn.textContent = 'Failed to load more';
        return;
      }
      const rawItems = result.data?.items || [];
      const items = epPath === '/workers' ? rawItems.map(flattenWorkerItem) : rawItems;
      const existingRowCount = btn.parentElement.querySelectorAll('.data-row').length;
      items.forEach((item, i) => {
        btn.insertAdjacentHTML('beforebegin', formatItemAsHTML(epPath, item, existingRowCount + i + 1, epName));
      });
      if (result.data?.hasMore && items.length > 0) {
        const urlObj = new URL(nextUrl);
        const currentOffset = parseInt(urlObj.searchParams.get('offset') || '0', 10);
        urlObj.searchParams.set('offset', String(currentOffset + items.length));
        btn.dataset.nextUrl = urlObj.toString();
        btn.disabled = false;
        btn.textContent = 'Load more';
      } else {
        btn.remove();
      }
    } catch (err) {
      btn.textContent = 'Failed to load more';
      console.error('[Renderer] Load more failed:', err.message);
    }
  });

  // Clear chat - must reset the in-memory conversationHistory AND persist the empty
  // state, not just wipe the visible DOM. Otherwise the "cleared" messages still feed
  // the LLM as context on the next message, and reappear on the next app launch since
  // loadInitialState() reloads conversationHistory from the store and replays it.
  document.getElementById('clearChatBtn').addEventListener('click', async () => {
    document.getElementById('messages').innerHTML = '';
    conversationHistory = [];
    try { await window.savvy.saveConversationHistory(conversationHistory); } catch {}
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

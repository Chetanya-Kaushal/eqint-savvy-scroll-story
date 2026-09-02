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
  const auth = 'Basic ' + btoa(settings.oracleUser + ':' + settings.oraclePass);
  let resp;
  try {
    resp = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  } catch (err) {
    throw new Error('Network error: ' + err.message + ' — check your Oracle URL is reachable.');
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error('Oracle API returned ' + resp.status + ': ' + body.slice(0, 200));
  }
  return resp.json();
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

  if (!settings.oracleUrl || !settings.oracleUser) {
    return '\n[ERROR] Oracle Fusion not configured. Please enter your URL, username, and password in Settings.';
  }

  const oracleKeywords = ['absence', 'leave', 'employee', 'worker', 'team', 'department', 'location', 'job', 'position', 'payroll', 'salary', 'pay', 'benefit', 'insurance', 'time card', 'timesheet', 'hours', 'clock', 'performance', 'review', 'goal', 'learning', 'course', 'training', 'checklist', 'task', 'hcm', 'oracle', 'grade', 'headcount', 'head count', 'hire', 'termination', 'transfer'];
  const isOracleRelated = oracleKeywords.some(kw => msg.includes(kw));

  if (!isOracleRelated) {
    return '\n[INFO] I can only help with Oracle Fusion HCM questions. Please ask about absences, employees, departments, payroll, benefits, time cards, or other HCM topics.';
  }

  let personFilter = '';
  const personMatch = msg.match(/(?:employee|worker|person|team member)\s+([a-zA-Z0-9\s]+?)(?:\s+in|\s+from|\s+with|\s+for|\s+show|\s+get|\s+list|\s*$)/i);
  if (personMatch && personMatch[1]) {
    personFilter = personMatch[1].trim();
  }

  try {
    if (msg.includes('absence') || msg.includes('leave') || msg.includes('time off') || msg.includes('vacation') || msg.includes('sick')) {
      const data = await oracleFetch('/absences?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((a, i) => `${i+1}. ${formatAbsence(a)}`);
        return '\n[ORACLE DATA - ABSENCES]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No absence records found.';
    }

    if (msg.includes('employee') || msg.includes('worker') || msg.includes('team') || msg.includes('person') || msg.includes('list') || msg.includes('number') || msg.includes('headcount') || msg.includes('hire')) {
      const data = await oracleFetch('/workers?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((w, i) => `${i+1}. ${formatWorker(w)}`);
        return '\n[ORACLE DATA - EMPLOYEES]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No employee records found.';
    }

    if (msg.includes('department') || msg.includes('dept')) {
      const data = await oracleFetch('/departments?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((d, i) => `${i+1}. ${formatDepartment(d)}`);
        return '\n[ORACLE DATA - DEPARTMENTS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No department records found.';
    }

    if (msg.includes('location') || msg.includes('office') || msg.includes('site')) {
      const data = await oracleFetch('/locations?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((l, i) => `${i+1}. ${formatLocation(l)}`);
        return '\n[ORACLE DATA - LOCATIONS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No location records found.';
    }

    if (msg.includes('job') || msg.includes('role')) {
      const data = await oracleFetch('/jobs?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((j, i) => `${i+1}. ${formatJob(j)}`);
        return '\n[ORACLE DATA - JOBS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No job records found.';
    }

    if (msg.includes('position')) {
      const data = await oracleFetch('/positions?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((p, i) => `${i+1}. ${formatPosition(p)}`);
        return '\n[ORACLE DATA - POSITIONS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No position records found.';
    }

    if (msg.includes('grade') || msg.includes('salary band') || msg.includes('compensation')) {
      const data = await oracleFetch('/grades?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((g, i) => `${i+1}. ${formatGrade(g)}`);
        return '\n[ORACLE DATA - GRADES]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No grade records found.';
    }

    if (msg.includes('time card') || msg.includes('timesheet') || msg.includes('hours worked') || msg.includes('clock') || msg.includes('attendance')) {
      const data = await oracleFetch('/timeCards?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((t, i) => `${i+1}. ${formatTimeCard(t)}`);
        return '\n[ORACLE DATA - TIME CARDS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No time card records found.';
    }

    if (msg.includes('payroll') || msg.includes('pay') || msg.includes('salary') || msg.includes('earning') || msg.includes('deduction')) {
      const data = await oracleFetch('/payrollElements?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((p, i) => `${i+1}. ${formatPayroll(p)}`);
        return '\n[ORACLE DATA - PAYROLL]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No payroll records found.';
    }

    if (msg.includes('benefit') || msg.includes('insurance') || msg.includes('401k') || msg.includes('enrollment')) {
      const data = await oracleFetch('/benefitEnrollments?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((b, i) => `${i+1}. ${formatBenefit(b)}`);
        return '\n[ORACLE DATA - BENEFITS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No benefit records found.';
    }

    if (msg.includes('performance') || msg.includes('review') || msg.includes('evaluation')) {
      const data = await oracleFetch('/performanceReviews?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((r, i) => `${i+1}. ${formatPerformanceReview(r)}`);
        return '\n[ORACLE DATA - PERFORMANCE REVIEWS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No performance review records found.';
    }

    if (msg.includes('goal') || msg.includes('objective') || msg.includes('target')) {
      const data = await oracleFetch('/goals?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((g, i) => `${i+1}. ${formatGoal(g)}`);
        return '\n[ORACLE DATA - GOALS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No goal records found.';
    }

    if (msg.includes('course') || msg.includes('training') || msg.includes('learning')) {
      const data = await oracleFetch('/learningCourses?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((c, i) => `${i+1}. ${formatCourse(c)}`);
        return '\n[ORACLE DATA - LEARNING COURSES]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No learning course records found.';
    }

    if (msg.includes('enrollment') && (msg.includes('learning') || msg.includes('course') || msg.includes('training'))) {
      const data = await oracleFetch('/learningEnrollments?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((e, i) => `${i+1}. ${formatLearningEnrollment(e)}`);
        return '\n[ORACLE DATA - LEARNING ENROLLMENTS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No learning enrollment records found.';
    }

    if (msg.includes('checklist') || msg.includes('task') || msg.includes('onboarding')) {
      const data = await oracleFetch('/allocatedChecklists?onlyData=true&limit=20');
      if (data.items && data.items.length > 0) {
        const lines = data.items.map((c, i) => `${i+1}. ${formatChecklist(c)}`);
        return '\n[ORACLE DATA - CHECKLISTS]\n' + lines.join('\n');
      }
      return '\n[ORACLE DATA] No checklist records found.';
    }
  } catch (err) {
    return '\n[ERROR] ' + err.message;
  }

  return null;
}

// Format worker data
function formatWorker(w) {
  const name = w.DisplayName || ((w.FirstName || '') + ' ' + (w.LastName || '')).trim() || 'N/A';
  return [
    `Name: ${name}`,
    `Person#: ${w.PersonNumber || 'N/A'}`,
    `Department: ${w.DepartmentName || 'N/A'}`,
    `Job: ${w.JobName || w.PositionName || 'N/A'}`,
    `Location: ${w.LocationName || 'N/A'}`,
    `Status: ${w.EmploymentStatus || w.WorkerType || 'N/A'}`,
    `Hire Date: ${w.HireDate || w.PeriodOfServiceStartDate || 'N/A'}`,
    `Email: ${w.WorkEmail || w.EmailAddress || 'N/A'}`,
    `Phone: ${w.WorkPhone || w.PhoneNumber || 'N/A'}`,
    `Manager: ${w.ManagerName || 'N/A'}`,
    `Grade: ${w.GradeName || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format absence data
function formatAbsence(a) {
  return [
    `Type: ${a.AbsenceType || a.AbsenceTypeName || 'N/A'}`,
    `From: ${a.StartDate || 'N/A'}`,
    `To: ${a.EndDate || 'N/A'}`,
    `Days: ${a.AbsenceDays || a.Duration || 'N/A'}`,
    `Status: ${a.AbsenceStatus || a.ApprovalStatus || 'N/A'}`,
    `Reason: ${a.AbsenceReason || 'N/A'}`,
    `Employee: ${a.PersonNumber || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format department data
function formatDepartment(d) {
  return [
    `Name: ${d.Name || d.NameTL || 'N/A'}`,
    `Code: ${d.DepartmentCode || 'N/A'}`,
    `Manager: ${d.ManagerName || 'N/A'}`,
    `Location: ${d.LocationName || 'N/A'}`,
    `Business Unit: ${d.BusinessUnitName || 'N/A'}`,
    `Cost Center: ${d.CostCenter || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format location data
function formatLocation(l) {
  const address = [l.AddressLine1, l.City, l.Region, l.Country, l.PostalCode].filter(x => x).join(', ');
  return [
    `Name: ${l.Name || 'N/A'}`,
    `Code: ${l.LocationCode || 'N/A'}`,
    `Address: ${address || 'N/A'}`,
    `Timezone: ${l.TimeZone || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format job data
function formatJob(j) {
  return [
    `Name: ${j.Name || 'N/A'}`,
    `Code: ${j.JobCode || 'N/A'}`,
    `Family: ${j.JobFamilyName || 'N/A'}`,
    `Category: ${j.JobCategory || 'N/A'}`,
    `Manager Level: ${j.ManagerLevel || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format time card data
function formatTimeCard(t) {
  return [
    `Period: ${t.PayrollPeriodName || 'N/A'}`,
    `${t.StartDate || 'N/A'} to ${t.EndDate || 'N/A'}`,
    `Hours: ${t.TotalHours || 'N/A'}`,
    `Status: ${t.TimeCardStatus || 'N/A'}`,
    `Employee: ${t.PersonNumber || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format payroll data
function formatPayroll(p) {
  return [
    `Type: ${p.Name || p.ElementName || 'N/A'}`,
    `Amount: ${p.Value || p.Amount || 'N/A'} ${p.Currency || ''}`,
    `Effective: ${p.EffectiveStartDate || 'N/A'}`,
    `Employee: ${p.PersonNumber || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format benefit data
function formatBenefit(b) {
  return [
    `Plan: ${b.BenefitPlanName || b.PlanName || 'N/A'}`,
    `Status: ${b.EnrollmentStatus || 'N/A'}`,
    `Coverage: ${b.CoverageLevel || 'N/A'}`,
    `Provider: ${b.ProviderName || 'N/A'}`,
    `Effective: ${b.EffectiveStartDate || 'N/A'}`,
    `Employee: ${b.PersonNumber || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format position data
function formatPosition(p) {
  return [
    `Name: ${p.Name || 'N/A'}`,
    `Code: ${p.PositionCode || 'N/A'}`,
    `Department: ${p.DepartmentName || 'N/A'}`,
    `Job: ${p.JobName || 'N/A'}`,
    `Location: ${p.LocationName || 'N/A'}`,
    `Headcount: ${p.PositionCurrentSize || 0}/${p.PositionMaxSize || 'N/A'}`,
    `Status: ${p.Status || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format grade data
function formatGrade(g) {
  return [
    `Name: ${g.Name || 'N/A'}`,
    `Code: ${g.GradeCode || 'N/A'}`,
    `Min Salary: ${g.MinimumSalary || 'N/A'} ${g.Currency || ''}`,
    `Max Salary: ${g.MaximumSalary || 'N/A'} ${g.Currency || ''}`,
    `Status: ${g.Status || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format performance review data
function formatPerformanceReview(r) {
  return [
    `Period: ${r.ReviewPeriod || 'N/A'}`,
    `Rating: ${r.OverallRating || 'N/A'}`,
    `Status: ${r.Status || 'N/A'}`,
    `Reviewer: ${r.ReviewerName || 'N/A'}`,
    `Employee: ${r.PersonNumber || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format goal data
function formatGoal(g) {
  return [
    `Goal: ${g.GoalName || 'N/A'}`,
    `Type: ${g.GoalType || 'N/A'}`,
    `Status: ${g.Status || 'N/A'}`,
    `Due: ${g.DueDate || 'N/A'}`,
    `Progress: ${g.Progress || 0}%`,
    `Employee: ${g.PersonNumber || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format learning course data
function formatCourse(c) {
  return [
    `Course: ${c.CourseName || 'N/A'}`,
    `Code: ${c.CourseCode || 'N/A'}`,
    `Category: ${c.Category || 'N/A'}`,
    `Duration: ${c.Duration || 'N/A'} ${c.DurationUnit || ''}`,
    `Status: ${c.Status || 'N/A'}`,
    `Enrollments: ${c.CurrentEnrollments || 0}/${c.MaxEnrollments || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format learning enrollment data
function formatLearningEnrollment(e) {
  return [
    `Course: ${e.CourseName || 'N/A'}`,
    `Status: ${e.EnrollmentStatus || 'N/A'}`,
    `Score: ${e.Score || 'N/A'}`,
    `Completed: ${e.CompletionDate || 'N/A'}`,
    `Employee: ${e.PersonNumber || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
}

// Format checklist data
function formatChecklist(c) {
  return [
    `Checklist: ${c.ChecklistName || 'N/A'}`,
    `Type: ${c.ChecklistType || 'N/A'}`,
    `Status: ${c.Status || 'N/A'}`,
    `Due: ${c.DueDate || 'N/A'}`,
    `Assigned To: ${c.AssignedToName || 'N/A'}`,
    `Employee: ${c.PersonNumber || 'N/A'}`
  ].filter(x => !x.endsWith('N/A')).join(' | ');
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
8. Be brief and direct. No extra words.`;

  let fullMsg = msg;

  if (pageContext) {
    fullMsg = '[CURRENT ORACLE PAGE]\n' + pageContext.substring(0, 2000) + '\n\n' + fullMsg;
  }

  // Auto-fetch real data from Oracle HCM based on user intent
  const fetchedData = await autoFetchData(msg);
  if (fetchedData) {
    fullMsg = fetchedData + '\n\n' + fullMsg;
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

  const botMsg = addMessage('', 'bot');
  let fullText = '';

  const reply = await callLLM(messages, (chunk) => {
    fullText += chunk;
    botMsg.querySelector('.msg-text').textContent = fullText;
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  });

  // Save to conversation history
  conversationHistory.push({ role: 'user', content: msg, timestamp: Date.now() });
  conversationHistory.push({ role: 'bot', content: fullText || reply, timestamp: Date.now() });
  try { await window.savvy.invoke('set-conversation-history', JSON.stringify(conversationHistory.slice(-100))); } catch {}
}

// ── Understand (HCM Discovery) ──
async function runDiscovery() {
  const btn = document.getElementById('understandBtn');
  const progressDiv = document.getElementById('understand-progress');
  const statusDiv = document.getElementById('understand-status');
  const summaryDiv = document.getElementById('understand-summary');

  if (!settings.oracleUrl || !settings.oracleUser) {
    statusDiv.style.display = 'block';
    statusDiv.style.background = '#fef2f2';
    statusDiv.style.border = '1px solid #fecaca';
    statusDiv.style.color = '#991b1b';
    statusDiv.textContent = 'Oracle Fusion not configured. Please enter your URL, username, and password in Settings.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Loading...';
  progressDiv.style.display = 'block';
  progressDiv.innerHTML = '';
  statusDiv.style.display = 'none';
  summaryDiv.style.display = 'none';

  const categories = ['department', 'location', 'job', 'position', 'grade'];
  let totalRecords = 0;

  try {
    for (const cat of categories) {
      const line = document.createElement('div');
      line.style.cssText = 'font-size:11px;color:#64748b;padding:2px 0;';
      line.textContent = `\u25CB Fetching ${cat}...`;
      progressDiv.appendChild(line);

      try {
        const resourceMap = { department: '/departments', location: '/locations', job: '/jobs', position: '/positions', grade: '/grades' };
        const data = await oracleFetch(resourceMap[cat] + '?onlyData=true&limit=20');
        const records = data?.items || [];
        totalRecords += records.length;
        line.textContent = `\u2713 ${cat}: ${records.length} records`;
        line.style.color = '#166534';
      } catch (err) {
        line.textContent = `\u2717 ${cat}: ${err.message}`;
        line.style.color = '#991b1b';
      }
      progressDiv.scrollTop = progressDiv.scrollHeight;
    }

    statusDiv.style.display = 'block';
    statusDiv.style.background = '#f0fdf4';
    statusDiv.style.border = '1px solid #bbf7d0';
    statusDiv.style.color = '#166534';
    statusDiv.textContent = `Loaded! ${totalRecords} reference records from backend.`;
  } catch (err) {
    statusDiv.style.display = 'block';
    statusDiv.style.background = '#fef2f2';
    statusDiv.style.border = '1px solid #fecaca';
    statusDiv.style.color = '#991b1b';
    statusDiv.textContent = 'Load failed: ' + err.message;
  }

  btn.disabled = false;
  btn.textContent = 'Load Reference Data';
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
  div.innerHTML = `<div class="msg-avatar">${avatar}</div><div class="msg-text">${text.replace(/\n/g, '<br>')}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
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

  if (restorePos.x !== null && restorePos.y !== null) {
    await window.savvy.setOverlayPosition(restorePos);
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

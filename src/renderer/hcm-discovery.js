/**
 * Oracle HCM REST API Discovery
 * Calls all HCM endpoints to understand the system and build a data repository.
 */

class HCMDiscovery {
  constructor(settings) {
    this.fusionUrl = settings.oracleUrl || '';
    this.username = settings.oracleUser || '';
    this.password = settings.oraclePass || '';
    this.restBase = this.fusionUrl ? this.fusionUrl + '/hcmRestApi/resources/latest' : '';
    this.data = {};
    this.progress = [];
    this.onError = null;
    this.onProgress = null;
  }

  _auth() {
    return 'Basic ' + btoa(this.username + ':' + this.password);
  }

  _headers() {
    return {
      'Authorization': this._auth(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  _log(msg, status) {
    this.progress.push({ msg, status, time: Date.now() });
    if (this.onProgress) this.onProgress(msg, status);
  }

  async _fetch(endpoint, params = {}, retries = 3) {
    const url = new URL(this.restBase + endpoint);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await window.savvy.oracleApi(url.toString(), this.username, this.password);

        if (!result.ok) {
          if (result.status === 401) {
            throw new Error('Authentication failed. Check your Oracle username and password.');
          }
          if (result.status === 403) {
            throw new Error('Access denied. Your account may not have permission to access this resource.');
          }
          if (result.status === 404) {
            throw new Error('Resource not found. This endpoint may not be available in your Oracle version.');
          }
          if (result.status === 429) {
            const waitTime = Math.pow(2, attempt) * 1000;
            this._log(`Rate limited, waiting ${waitTime/1000}s before retry...`, 'loading');
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
          throw new Error(`HTTP ${result.status}: ${(result.body || '').substring(0, 200)}`);
        }

        return result.data;
      } catch (err) {
        lastError = err;
        if (attempt < retries && !err.message.includes('Authentication failed') && !err.message.includes('Access denied')) {
          this._log(`Retry ${attempt}/${retries} for ${endpoint}...`, 'loading');
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    
    throw new Error(`${endpoint}: ${lastError.message}`);
  }

  async _fetchAll(endpoint, params = {}, maxItems = 200) {
    const allItems = [];
    let offset = 0;
    const limit = 50;

    while (allItems.length < maxItems) {
      try {
        const result = await this._fetch(endpoint, { ...params, offset, limit });
        const items = result.items || result;
        if (!Array.isArray(items) || items.length === 0) break;
        allItems.push(...items);
        if (items.length < limit) break;
        offset += limit;
      } catch (err) {
        if (allItems.length === 0) throw err;
        break; // Return what we have
      }
    }

    return allItems;
  }

  async _discoverOne(name, endpoint, params = {}, maxItems = 200) {
    try {
      this._log(`Fetching ${name}...`, 'loading');
      const items = await this._fetchAll(endpoint, params, maxItems);
      this.data[name] = items;
      
      if (items.length === 0) {
        this._log(`${name}: No data found (endpoint may not be available)`, 'error');
      } else {
        this._log(`${name}: ${items.length} records`, 'done');
      }
      
      return items;
    } catch (err) {
      const errorMessage = err.message || 'Unknown error';
      
      // Provide more specific error messages
      if (errorMessage.includes('401')) {
        this._log(`${name}: Authentication expired - please refresh and try again`, 'error');
      } else if (errorMessage.includes('403')) {
        this._log(`${name}: Access denied - your account may not have permission`, 'error');
      } else if (errorMessage.includes('404')) {
        this._log(`${name}: Endpoint not available in your Oracle version`, 'error');
      } else if (errorMessage.includes('timeout')) {
        this._log(`${name}: Request timed out - server may be slow`, 'error');
      } else {
        this._log(`${name}: ${errorMessage}`, 'error');
      }
      
      this.data[name] = [];
      return [];
    }
  }

  async runAll(onProgress) {
    this.onProgress = onProgress;
    this.data = {};
    this.progress = [];

    if (!this.fusionUrl || !this.username || !this.password) {
      this._log('ERROR: Oracle URL, username, and password required. Set them in Settings.', 'error');
      return this.data;
    }

    this._log('Authenticating to Oracle HCM...', 'loading');

    // Test connection first
    try {
      const testUrl = this.restBase + '/workers?limit=1';
      const result = await window.savvy.oracleApi(testUrl, this.username, this.password);
      
      if (!result.ok) {
        if (result.status === 401) {
          this._log('Authentication failed. Please check your Oracle credentials.', 'error');
          return this.data;
        }
        if (result.status === 403) {
          this._log('Access denied. Your account may not have permission to access HCM APIs.', 'error');
          return this.data;
        }
        throw new Error(`HTTP ${result.status}`);
      }
      
      this._log('Connected to Oracle HCM', 'done');
    } catch (err) {
      if (err.message.includes('timed out')) {
        this._log('Connection timeout. Please check your Oracle URL and network connection.', 'error');
      } else {
        this._log(`Connection failed: ${err.message}`, 'error');
      }
      return this.data;
    }

    // Discover all modules
    const discoveries = [
      // Core HR
      ['employees', '/workers', {}, 500],
      ['departments', '/departments', {}, 200],
      ['locations', '/locations', {}, 200],
      ['organizations', '/organizations', {}, 200],
      ['jobs', '/jobs', {}, 200],
      ['grades', '/grades', {}, 100],
      ['positions', '/positions', {}, 200],

      // Time & Absence
      ['absences', '/absences', {}, 200],
      ['timeCards', '/timeCards', {}, 100],

      // Payroll
      ['payrollElements', '/payrollElements', {}, 100],

      // Benefits
      ['benefitPlans', '/benefitPlans', {}, 50],
      ['benefitEnrollments', '/benefitEnrollments', {}, 200],

      // Performance
      ['performanceReviews', '/performanceReviews', {}, 100],
      ['goals', '/goals', {}, 200],

      // Learning
      ['learningCourses', '/learningCourses', {}, 100],
      ['learningEnrollments', '/learningEnrollments', {}, 100],
    ];

    for (const [name, endpoint, params, max] of discoveries) {
      await this._discoverOne(name, endpoint, params, max);
    }

    this._log(`Discovery complete! ${Object.keys(this.data).length} modules scanned.`, 'done');
    return this.data;
  }

  /**
   * Build a summary of the organization for the LLM context.
   */
  buildSummary() {
    const parts = [];

    // Employee summary
    const emps = this.data.employees || [];
    if (emps.length > 0) {
      parts.push(`EMPLOYEES: ${emps.length} total`);
      // Department breakdown
      const deptCounts = {};
      emps.forEach(e => {
        const dept = e.DepartmentName || e.DepartmentId || 'Unknown';
        deptCounts[dept] = (deptCounts[dept] || 0) + 1;
      });
      const topDepts = Object.entries(deptCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
      topDepts.forEach(([dept, count]) => parts.push(`  - ${dept}: ${count} employees`));
    }

    // Departments
    const depts = this.data.departments || [];
    if (depts.length > 0) {
      parts.push(`\nDEPARTMENTS: ${depts.length}`);
      depts.slice(0, 10).forEach(d => {
        parts.push(`  - ${d.Name || d.NameTL || d.OrganizationId}`);
      });
    }

    // Locations
    const locs = this.data.locations || [];
    if (locs.length > 0) {
      parts.push(`\nLOCATIONS: ${locs.length}`);
      locs.slice(0, 5).forEach(l => {
        parts.push(`  - ${l.Name || l.LocationId}`);
      });
    }

    // Absences
    const abs = this.data.absences || [];
    if (abs.length > 0) {
      parts.push(`\nABSENCES: ${abs.length} records`);
      const typeCounts = {};
      abs.forEach(a => {
        const t = a.AbsenceType || a.Type || 'Unknown';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      });
      Object.entries(typeCounts).forEach(([t, c]) => parts.push(`  - ${t}: ${c}`));
    }

    // Payroll
    const payslips = this.data.payslips || [];
    if (payslips.length > 0) {
      parts.push(`\nPAYROLL: ${payslips.length} payslips`);
    }

    // Jobs
    const jobs = this.data.jobs || [];
    if (jobs.length > 0) {
      parts.push(`\nJOBS: ${jobs.length}`);
      jobs.slice(0, 10).forEach(j => parts.push(`  - ${j.Name || j.JobId}`));
    }

    // Performance
    const reviews = this.data.performanceReviews || [];
    if (reviews.length > 0) {
      parts.push(`\nPERFORMANCE REVIEWS: ${reviews.length}`);
    }

    return parts.join('\n');
  }

  /**
   * Search the repository for context related to a query.
   */
  searchContext(query) {
    const q = query.toLowerCase();
    const parts = [];

    // Search employees
    const emps = this.data.employees || [];
    const matchedEmps = emps.filter(e => {
      const name = (e.DisplayName || e.FirstName || '').toLowerCase();
      const dept = (e.DepartmentName || '').toLowerCase();
      return name.includes(q) || dept.includes(q) || q.includes(dept);
    }).slice(0, 5);

    if (matchedEmps.length > 0) {
      parts.push('MATCHED EMPLOYEES:');
      matchedEmps.forEach(e => {
        parts.push(`  - ${e.DisplayName || e.FirstName + ' ' + e.LastName} | Dept: ${e.DepartmentName} | Job: ${e.JobName || e.PositionName} | Status: ${e.WorkerType}`);
      });
    }

    // Search absences
    const abs = this.data.absences || [];
    const matchedAbs = abs.filter(a => {
      const person = (a.PersonId || '').toString();
      const type = (a.AbsenceType || '').toLowerCase();
      return q.includes(person) || type.includes(q);
    }).slice(0, 5);

    if (matchedAbs.length > 0) {
      parts.push('MATCHED ABSENCES:');
      matchedAbs.forEach(a => {
        parts.push(`  - ${a.AbsenceType || a.Type} | ${a.StartDate || ''} to ${a.EndDate || ''} | Status: ${a.ApprovalStatus || a.Status}`);
      });
    }

    // Search departments
    const depts = this.data.departments || [];
    const matchedDepts = depts.filter(d => {
      const name = (d.Name || d.NameTL || '').toLowerCase();
      return name.includes(q) || q.includes(name);
    }).slice(0, 3);

    if (matchedDepts.length > 0) {
      parts.push('MATCHED DEPARTMENTS:');
      matchedDepts.forEach(d => {
        parts.push(`  - ${d.Name || d.NameTL} | Manager: ${d.ManagerName || 'N/A'}`);
      });
    }

    return parts.join('\n');
  }

  getProgress() {
    return this.progress;
  }

  getData() {
    return this.data;
  }

  getDiscoverySummary() {
    const summary = {
      totalModules: Object.keys(this.data).length,
      totalRecords: Object.values(this.data).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0),
      successfulModules: Object.entries(this.data).filter(([_, arr]) => Array.isArray(arr) && arr.length > 0).map(([name, arr]) => `${name}: ${arr.length}`),
      failedModules: Object.entries(this.data).filter(([_, arr]) => !Array.isArray(arr) || arr.length === 0).map(([name]) => name),
      errors: this.progress.filter(p => p.status === 'error').map(p => p.msg),
    };
    return summary;
  }
}

// Export for use in overlay.js
if (typeof module !== 'undefined') {
  module.exports = { HCMDiscovery };
}

#!/usr/bin/env node
/**
 * Oracle HCM REST API Explorer
 * Runs all standard GET endpoints and documents response formats.
 * 
 * Usage: node scripts/hcm-api-explorer.js <baseUrl> <username> <password>
 * Example: node scripts/hcm-api-explorer.js https://yourcompany.fa.us2.oraclecloud.com myuser mypassword
 */

const baseUrl = process.argv[2];
const username = process.argv[3];
const password = process.argv[4];

if (!baseUrl || !username || !password) {
  console.log('Usage: node scripts/hcm-api-explorer.js <baseUrl> <username> <password>');
  console.log('Example: node scripts/hcm-api-explorer.js https://yourcompany.fa.us2.oraclecloud.com myuser mypassword');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
const apiPrefix = baseUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05';

const endpoints = [
  { name: 'Workers', path: '/workers', params: '?onlyData=true&limit=5' },
  { name: 'Absences', path: '/absences', params: '?onlyData=true&limit=5' },
  { name: 'Departments', path: '/departments', params: '?onlyData=true&limit=5' },
  { name: 'Locations', path: '/locations', params: '?onlyData=true&limit=5' },
  { name: 'Jobs', path: '/jobs', params: '?onlyData=true&limit=5' },
  { name: 'Positions', path: '/positions', params: '?onlyData=true&limit=5' },
  { name: 'Grades', path: '/grades', params: '?onlyData=true&limit=5' },
  { name: 'Time Cards', path: '/timeCards', params: '?onlyData=true&limit=5' },
  { name: 'Payroll Elements', path: '/payrollElements', params: '?onlyData=true&limit=5' },
  { name: 'Benefit Enrollments', path: '/benefitEnrollments', params: '?onlyData=true&limit=5' },
  { name: 'Performance Reviews', path: '/performanceReviews', params: '?onlyData=true&limit=5' },
  { name: 'Goals', path: '/goals', params: '?onlyData=true&limit=5' },
  { name: 'Learning Courses', path: '/learningCourses', params: '?onlyData=true&limit=5' },
  { name: 'Learning Enrollments', path: '/learningEnrollments', params: '?onlyData=true&limit=5' },
  { name: 'Allocated Checklists', path: '/allocatedChecklists', params: '?onlyData=true&limit=5' },
  { name: 'Persons', path: '/persons', params: '?onlyData=true&limit=5' },
  { name: 'Employment', path: '/employment', params: '?onlyData=true&limit=5' },
  { name: 'Organizations', path: '/organizations', params: '?onlyData=true&limit=5' },
  { name: 'Projects', path: '/projects', params: '?onlyData=true&limit=5' },
  { name: 'Cost Centers', path: '/costCenters', params: '?onlyData=true&limit=5' },
  { name: 'Business Units', path: '/businessUnits', params: '?onlyData=true&limit=5' },
  { name: 'Enterprises', path: '/enterprises', params: '?onlyData=true&limit=5' },
  { name: 'Worker Locations', path: '/workerLocations', params: '?onlyData=true&limit=5' },
  { name: 'Worker Phones', path: '/workerPhones', params: '?onlyData=true&limit=5' },
  { name: 'Worker Emails', path: '/workerEmails', params: '?onlyData=true&limit=5' },
  { name: 'Worker Addresses', path: '/workerAddresses', params: '?onlyData=true&limit=5' },
  { name: 'Worker National Identifications', path: '/workerNationalIdentifications', params: '?onlyData=true&limit=5' },
  { name: 'Salary Changes', path: '/salaryChanges', params: '?onlyData=true&limit=5' },
  { name: 'Work Relationships', path: '/workRelationships', params: '?onlyData=true&limit=5' },
  { name: 'Work Assignments', path: '/workAssignments', params: '?onlyData=true&limit=5' },
];

async function fetchEndpoint(ep) {
  const url = apiPrefix + ep.path + ep.params;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { status: resp.status, error: body.slice(0, 300), data: null };
    }
    const data = await resp.json();
    return { status: resp.status, error: null, data };
  } catch (err) {
    return { status: 0, error: err.message, data: null };
  }
}

function analyzeResponse(name, result) {
  const lines = [];
  lines.push(`\n${'='.repeat(60)}`);
  lines.push(`ENDPOINT: ${name}`);
  lines.push(`${'='.repeat(60)}`);

  if (result.error) {
    lines.push(`STATUS: ${result.status} (ERROR)`);
    lines.push(`ERROR: ${result.error}`);
    return lines.join('\n');
  }

  lines.push(`STATUS: ${result.status} (OK)`);
  const data = result.data;
  const keys = Object.keys(data);
  lines.push(`TOP-LEVEL KEYS: ${keys.join(', ')}`);

  if (data.items && Array.isArray(data.items)) {
    lines.push(`ITEMS COUNT: ${data.items.length}`);
    if (data.items.length > 0) {
      const item = data.items[0];
      lines.push(`FIRST ITEM KEYS: ${Object.keys(item).join(', ')}`);
      lines.push(`\nFIRST ITEM (sample):`);
      lines.push(JSON.stringify(item, null, 2).split('\n').slice(0, 30).join('\n'));
    }
  } else {
    lines.push(`\nFULL RESPONSE (sample):`);
    lines.push(JSON.stringify(data, null, 2).split('\n').slice(0, 30).join('\n'));
  }

  return lines.join('\n');
}

async function main() {
  console.log('Oracle HCM REST API Explorer');
  console.log('Base URL:', apiPrefix);
  console.log('Running', endpoints.length, 'endpoints...\n');

  const results = [];
  const reference = [];

  for (const ep of endpoints) {
    process.stdout.write(`  Testing ${ep.name}...`);
    const result = await fetchEndpoint(ep);
    const analysis = analyzeResponse(ep.name, result);
    console.log(result.error ? ` FAIL (${result.status})` : ` OK (${result.data.items?.length || 0} items)`);

    results.push({ endpoint: ep.name, path: ep.path, status: result.status, error: result.error, data: result.data });

    if (!result.error && result.data?.items?.length > 0) {
      const item = result.data.items[0];
      reference.push({
        endpoint: ep.name,
        path: ep.path,
        method: 'GET',
        url: apiPrefix + ep.path + ep.params,
        responseKeys: Object.keys(item),
        sample: item,
      });
    }
  }

  // Write full analysis
  const fs = require('fs');
  const analysisPath = __dirname + '/../docs/hcm-api-analysis.txt';
  fs.writeFileSync(analysisPath, results.map(r => analyzeResponse(r.endpoint, r)).join('\n'));
  console.log('\n\nFull analysis written to:', analysisPath);

  // Write reference JSON
  const refPath = __dirname + '/../docs/hcm-api-reference.json';
  fs.writeFileSync(refPath, JSON.stringify(reference, null, 2));
  console.log('API reference written to:', refPath);

  // Summary
  console.log('\n\n=== SUMMARY ===');
  const working = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);
  console.log(`Working: ${working.length}/${results.length}`);
  console.log(`Failed: ${failed.length}/${results.length}`);
  if (failed.length > 0) {
    console.log('\nFailed endpoints:');
    failed.forEach(r => console.log(`  - ${r.endpoint}: ${r.status} ${r.error?.slice(0, 100)}`));
  }
}

main().catch(console.error);

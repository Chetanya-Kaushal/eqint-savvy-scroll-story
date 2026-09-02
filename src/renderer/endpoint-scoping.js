// Endpoints whose Oracle view object actually carries a PersonNumber/person-identifying
// attribute — safe to filter with `&q=PersonNumber='...'`. Everything else in HCM_ENDPOINTS
// is a reference/lookup table (Organizations, Locations, Jobs, Grades, *LOV endpoints, etc.)
// that has no such attribute — Oracle silently ignores an unrecognized filter attribute on
// many of these lookup view objects and returns the FULL unfiltered table instead of erroring,
// so these must never receive a person filter.
const PERSON_SCOPED_PATHS = new Set([
  '/workers', '/emps', '/publicWorkers', '/personNotes', '/hcmContacts', '/areasOfResponsibility',
  '/absences', '/absenceNoEntitlements',
  '/payrollRelationships', '/elementEntries', '/calculationEntries', '/payAdvances', '/planBalances',
  '/benefitEnrollments', '/benefitEnrollmentOpportunities',
  '/salaries', '/compensationPeerSalaryPercentiles', '/compensationStockProfiles',
  '/timeRecords', '/timeRecordGroups', '/timeAttributes', '/webClockEvents', '/scheduleRequests', '/attendanceViolations',
  '/performanceGoals', '/goalPlanAssignees', '/goalsProgressDetails', '/performanceEvaluations',
  '/talentPersonProfiles', '/talentRatings', '/talentFeedbackSuggestions', '/learnerLearningRecords',
  '/workerJourneys', '/workerJourneyTasks',
  '/recruitingJobApplications', '/recruitingMyJobApplications', '/recruitingCEInterviewScheduleDetails',
  '/documentRecords', '/communicateUIMyCommunications', '/checkInDocuments', '/allocatedChecklists',
  '/tasks', '/businessProcessNotifications', '/businessProcessTransactionManagementAsWorkers', '/statusChangeRequests',
  '/internetAccounts', '/userAccounts', '/emailAddrMigrations', '/documentDeliveryPreferences', '/careerInterests',
]);

function isPersonScoped(path) {
  return PERSON_SCOPED_PATHS.has(path);
}

function scopeEndpointsToPerson(endpoints) {
  const personScoped = endpoints.filter((ep) => isPersonScoped(ep.path));
  const referenceOnly = endpoints.filter((ep) => !isPersonScoped(ep.path));
  return { personScoped, referenceOnly };
}

module.exports = { isPersonScoped, scopeEndpointsToPerson, PERSON_SCOPED_PATHS };

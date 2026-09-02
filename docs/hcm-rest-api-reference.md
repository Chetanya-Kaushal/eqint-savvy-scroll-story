# Oracle HCM REST API Reference

## Base URL Pattern
```
{oracleUrl}/hcmRestApi/resources/11.13.18.05{resourcePath}
```

## Authentication
```
Authorization: Basic base64(username:password)
```

---

## Available Endpoints

### Workers (Employees)
```
GET /workers?onlyData=true&limit=20
```
**Response keys:** PersonNumber, DisplayName, FirstName, LastName, DepartmentName, JobName, PositionName, LocationName, EmploymentStatus, WorkerType, HireDate, PeriodOfServiceStartDate, WorkEmail, EmailAddress, WorkPhone, PhoneNumber, ManagerName, GradeName

### Absences
```
GET /absences?onlyData=true&limit=20
```
**Response keys:** AbsenceType, AbsenceTypeName, StartDate, EndDate, AbsenceDays, Duration, AbsenceStatus, ApprovalStatus, AbsenceReason, PersonNumber

### Departments
```
GET /departments?onlyData=true&limit=20
```
**Response keys:** Name, NameTL, DepartmentCode, ManagerName, LocationName, BusinessUnitName, CostCenter

### Locations
```
GET /locations?onlyData=true&limit=20
```
**Response keys:** Name, LocationCode, AddressLine1, City, Region, Country, PostalCode, TimeZone

### Jobs
```
GET /jobs?onlyData=true&limit=20
```
**Response keys:** Name, JobCode, JobFamilyName, JobLevel

### Positions
```
GET /positions?onlyData=true&limit=20
```
**Response keys:** Name, PositionCode, DepartmentName, JobName, LocationName, BudgetedPosition

### Grades
```
GET /grades?onlyData=true&limit=20
```
**Response keys:** Name, GradeCode, GradeLadderName, MinimumSalary, MaximumSalary, Currency

### Time Cards
```
GET /timeCards?onlyData=true&limit=20
```
**Response keys:** TimeCardId, EmployeeName, PersonNumber, DateStart, DateEnd, StatusCode, ApprovalStatus, TotalRegHours, TotalOthours

### Payroll Elements
```
GET /payrollElements?onlyData=true&limit=20
```
**Response keys:** ElementName, PersonNumber, EmployeeName, EffectiveStartDate, Amount, CurrencyCode, PayrollActionCode

### Benefit Enrollments
```
GET /benefitEnrollments?onlyData=true&limit=20
```
**Response keys:** PersonNumber, EmployeeName, BenefitName, PlanName, EnrollmentStatusCode, EffectiveStartDate

### Performance Reviews
```
GET /performanceReviews?onlyData=true&limit=20
```
**Response keys:** PersonNumber, EmployeeName, ReviewPeriodName, OverallRating, Status, ReviewDate

### Goals
```
GET /goals?onlyData=true&limit=20
```
**Response keys:** PersonNumber, EmployeeName, GoalName, GoalType, TargetDate, Status, Weight, PercentageComplete

### Learning Courses
```
GET /learningCourses?onlyData=true&limit=20
```
**Response keys:** CourseId, CourseName, CourseCode, Description, Duration, DurationUnit, Status

### Learning Enrollments
```
GET /learningEnrollments?onlyData=true&limit=20
```
**Response keys:** PersonNumber, EmployeeName, CourseName, EnrollmentStatus, CompletionDate, Score

### Allocated Checklists
```
GET /allocatedChecklists?onlyData=true&limit=20
```
**Response keys:** PersonNumber, EmployeeName, ChecklistName, Status, DueDate, CompletionPercentage

### Persons
```
GET /persons?onlyData=true&limit=20
```
**Response keys:** PersonNumber, DisplayName, FirstName, LastName, DateOfBirth, Gender, MaritalStatus

### Employment
```
GET /employment?onlyData=true&limit=20
```
**Response keys:** PersonNumber, EmployeeName, EmploymentStatus, WorkerType, HireDate, TerminationDate, LengthOfService

### Organizations
```
GET /organizations?onlyData=true&limit=20
```
**Response keys:** OrganizationId, Name, OrganizationCode, OrganizationType, Status

---

## Query Parameters
- `onlyData=true` — Returns only data items (no HATEOAS links)
- `limit=N` — Limits results to N items
- `offset=N` — Skips first N items (pagination)
- `q=FieldName=value` — Filters results (e.g., `q=PersonNumber=12345`)
- `onlyData=true&fields=Field1,Field2` — Returns only specified fields

## Filtering Examples
```
GET /workers?q=PersonNumber=12345
GET /absences?q=PersonNumber=12345&onlyData=true
GET /departments?q=Name=Finance
GET /locations?q=Country=US
```

## How to Call from JavaScript (Electron)
```javascript
async function oracleFetch(resourcePath) {
  const url = settings.oracleUrl.replace(/\/+$/, '') 
    + '/hcmRestApi/resources/11.13.18.05' + resourcePath;
  const auth = 'Basic ' + btoa(settings.oracleUser + ':' + settings.oraclePass);
  const resp = await fetch(url, {
    headers: { Authorization: auth, Accept: 'application/json' }
  });
  if (!resp.ok) throw new Error('Oracle API ' + resp.status);
  return resp.json(); // Returns { items: [...], count: N, ... }
}
```

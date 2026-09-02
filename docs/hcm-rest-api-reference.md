# Oracle HCM REST API Reference (Official)

## Base URL Pattern
```
{oracleUrl}/hcmRestApi/resources/11.13.18.05{resourcePath}
```

## Authentication
```
Authorization: Basic base64(username:password)
```

---

## Confirmed Endpoints (from Oracle docs)

### Workers
```
GET /workers?onlyData=true&limit=20
```
**Response keys:** PersonNumber, DisplayName, FirstName, LastName, DepartmentName, JobName, PositionName, LocationName, EmploymentStatus, WorkerType, HireDate, PeriodOfServiceStartDate, WorkEmail, EmailAddress, WorkPhone, PhoneNumber, ManagerName, GradeName

### Absences
```
GET /absences?onlyData=true&limit=20
```
**Response keys:** AbsenceType, AbsenceTypeName, StartDate, EndDate, AbsenceDays, Duration, AbsenceStatus, ApprovalStatus, AbsenceReason, PersonNumber

### Allocated Checklists
```
GET /allocatedChecklists?onlyData=true&limit=20
```
**Response keys:** PersonNumber, EmployeeName, ChecklistName, Status, DueDate, CompletionPercentage

### Areas of Responsibility
```
GET /areasOfResponsibility?onlyData=true&limit=20
```

### Assignment Statuses
```
GET /assignmentStatuses?onlyData=true&limit=20
```

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

### Payroll Relationships
```
GET /payrollRelationships?onlyData=true&limit=20
```

### Worker Locations
```
GET /workerLocations?onlyData=true&limit=20
```

### Worker Phones
```
GET /workerPhones?onlyData=true&limit=20
```

### Worker Emails
```
GET /workerEmails?onlyData=true&limit=20
```

### Worker Addresses
```
GET /workerAddresses?onlyData=true&limit=20
```

---

## Query Parameters
- `onlyData=true` — Returns only data items (no HATEOAS links)
- `limit=N` — Limits results to N items
- `offset=N` — Skips first N items (pagination)
- `q=FieldName=value` — Filters results (e.g., `q=PersonNumber=12345`)
- `fields=Field1,Field2` — Returns only specified fields

## Filtering Examples
```
GET /workers?q=PersonNumber=12345
GET /absences?q=PersonNumber=12345&onlyData=true
GET /departments?q=Name=Finance
GET /locations?q=Country=US
```

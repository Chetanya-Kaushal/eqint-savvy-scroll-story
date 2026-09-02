import { describe, it, expect } from 'vitest';
import { flattenWorkerItem } from '../../src/renderer/worker-profile.js';

// Trimmed fixture matching the real shape returned by a live Oracle Fusion HCM
// tenant's /workers?expand=names,emails,phones,workRelationships.assignments call.
const REAL_SHAPE_FIXTURE = {
  PersonId: 300000003022427,
  PersonNumber: 'NM1083',
  DateOfBirth: '1951-09-14',
  names: [
    {
      EffectiveStartDate: '2021-11-01',
      EffectiveEndDate: '4712-12-31',
      FirstName: 'MISHIKA MUKESH',
      LastName: 'GANDHIYAMMAL',
      DisplayName: 'MISHIKA MUKESH GANDHIYAMMAL',
    },
  ],
  emails: [{ EmailAddress: 'mishika.gandhiyammal@example.com' }],
  phones: [{ PhoneNumber: '+971-000-0000' }],
  workRelationships: [
    {
      PrimaryFlag: true,
      StartDate: '2021-11-01',
      LegalEmployerName: 'NOVOMED CENTERS L.L.C - BRANCH OF ABU DHABI 2',
      assignments: [
        {
          AssignmentName: 'Health Care Assistant',
          PrimaryAssignmentFlag: true,
          BusinessUnitName: 'Novomed Centers LLC-Branch Of Abu Dhabi 2-NC-Al Bateen',
          DepartmentName: 'Nursing',
          AssignmentStatusType: 'ACTIVE',
          FullPartTime: 'FULL_TIME',
          LastUpdatedBy: 'Maynard.Garcia',
        },
      ],
    },
  ],
};

describe('flattenWorkerItem', () => {
  it('extracts DisplayName, department, job title, and status from the real nested shape', () => {
    const flat = flattenWorkerItem(REAL_SHAPE_FIXTURE);
    expect(flat.DisplayName).toBe('MISHIKA MUKESH GANDHIYAMMAL');
    expect(flat.FirstName).toBe('MISHIKA MUKESH');
    expect(flat.LastName).toBe('GANDHIYAMMAL');
    expect(flat.DepartmentName).toBe('Nursing');
    expect(flat.BusinessUnitName).toBe('Novomed Centers LLC-Branch Of Abu Dhabi 2-NC-Al Bateen');
    expect(flat.JobTitle).toBe('Health Care Assistant');
    expect(flat.EmploymentStatus).toBe('ACTIVE');
    expect(flat.EmploymentType).toBe('FULL_TIME');
    expect(flat.StartDate).toBe('2021-11-01');
    expect(flat.EmailAddress).toBe('mishika.gandhiyammal@example.com');
    expect(flat.PhoneNumber).toBe('+971-000-0000');
  });

  it('never surfaces the assignment audit field (LastUpdatedBy) as if it were the person', () => {
    const flat = flattenWorkerItem(REAL_SHAPE_FIXTURE);
    expect(Object.values(flat)).not.toContain('Maynard.Garcia');
  });

  it('falls back to the first entry when no PrimaryFlag/PrimaryAssignmentFlag is present', () => {
    const noFlags = {
      names: [{ DisplayName: 'Jane Doe' }],
      workRelationships: [{ assignments: [{ DepartmentName: 'Sales', AssignmentName: 'Rep' }] }],
    };
    const flat = flattenWorkerItem(noFlags);
    expect(flat.DepartmentName).toBe('Sales');
    expect(flat.JobTitle).toBe('Rep');
  });

  it('leaves a non-Workers item (no names array) untouched', () => {
    const absenceItem = { AbsenceType: 'Sick Leave', StartDate: '2025-03-07' };
    expect(flattenWorkerItem(absenceItem)).toBe(absenceItem);
  });

  it('handles a worker record with no names/workRelationships gracefully', () => {
    const sparse = { PersonId: 1, names: [] };
    const flat = flattenWorkerItem(sparse);
    expect(flat.DisplayName).toBe(undefined);
    expect(flat.DepartmentName).toBe(undefined);
  });
});

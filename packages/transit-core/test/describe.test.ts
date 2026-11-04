import { describe, expect, it } from "vitest";
import { indexCalendar } from "../src/gtfs/calendar.ts";
import { makeServiceDescriber } from "../src/gtfs/describe.ts";
import { regularWeek } from "../src/schedule/frequency.ts";
import { serviceDate, type ServiceDate } from "../src/time.ts";

// Fall service to 23 November, then winter service to April (as Whistler's), with Thursday 31
// December on Sunday service.
const WEEKDAYS = [true, true, true, true, true, false, false];
const SUNDAYS = [false, false, false, false, false, false, true];
const period = (id: string, days: boolean[], start: string, end: string) => ({
  serviceId: id,
  days,
  start: serviceDate(start),
  end: serviceDate(end),
});
const servicesOn = indexCalendar({
  calendar: [
    period("fall", WEEKDAYS, "20261101", "20261123"),
    period("fall-su", SUNDAYS, "20261101", "20261123"),
    period("winter", WEEKDAYS, "20261124", "20270417"),
    period("winter-su", SUNDAYS, "20261124", "20270417"),
  ],
  exceptions: [
    { serviceId: "winter", date: serviceDate("20261231"), type: 2 },
    { serviceId: "winter-su", date: serviceDate("20261231"), type: 1 },
  ],
});
const start = serviceDate("20261101");
const end = serviceDate("20270417");

describe("makeServiceDescriber", () => {
  const describeDay = makeServiceDescriber(servicesOn, start, end);
  const label = (d: string) => describeDay(serviceDate(d)).label;

  it("finds regular days in each timetable period", () => {
    expect(label("20261103")).toBe("Tuesday");
    expect(label("20261117")).toBe("Tuesday");
    expect(label("20261124")).toBe("Tuesday");
    expect(label("20270309")).toBe("Tuesday");
  });

  it("tells holidays and days without service apart", () => {
    expect(label("20261231")).toBe("Thursday: holiday (Sunday service)");
    expect(label("20261107")).toBe("Saturday: no service in this timetable");
  });
});

describe("regularWeek", () => {
  it("takes the period the feed starts in, not its longest", () => {
    const week: ServiceDate[] = regularWeek(servicesOn, start, end);
    expect(week[1]).toBe("20261103");
  });
});

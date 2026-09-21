// The staff console's route table lands with the screens themselves (Task 11+). This placeholder
// is the one the attendee router already mounted at `/staff/*`, moved to the name the rest of
// sub-plan 04 imports; the staff-only Capacitor build renders this same component rather than a
// second copy of it, so there is nothing to keep in step.
export function StaffRoutes() {
  return <main className="screen">staff</main>;
}

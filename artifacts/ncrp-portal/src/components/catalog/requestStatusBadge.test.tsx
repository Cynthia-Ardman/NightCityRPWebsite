import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { RequestStatusBadge } from "./requestStatusBadge";

// A review decision of "approved" only STAGES the outcome — a staff member must
// still click "Close and Apply" before the effect takes hold and the owner is
// notified. Owner-facing surfaces for deferred-apply subjects pass
// `stagedApproval` so the row never reads "APPROVED" prematurely. These tests
// lock that contract so the leak can't silently regress.
describe("RequestStatusBadge", () => {
  it("shows APPROVED for a staged decision when stagedApproval is not set (staff / immediate-apply surfaces)", () => {
    render(<RequestStatusBadge status="approved" />);
    expect(screen.getByText("APPROVED")).toBeInTheDocument();
    expect(screen.queryByText("IN REVIEW")).not.toBeInTheDocument();
  });

  it("masks a staged approval as IN REVIEW for the owner when stagedApproval is set", () => {
    render(<RequestStatusBadge status="approved" stagedApproval />);
    expect(screen.getByText("IN REVIEW")).toBeInTheDocument();
    expect(screen.queryByText("APPROVED")).not.toBeInTheDocument();
  });

  it("does not affect non-approved statuses when stagedApproval is set", () => {
    render(<RequestStatusBadge status="rejected" stagedApproval />);
    expect(screen.getByText("REJECTED")).toBeInTheDocument();
    expect(screen.queryByText("IN REVIEW")).not.toBeInTheDocument();
  });
});

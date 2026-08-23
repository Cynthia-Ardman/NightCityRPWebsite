import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CustomRequest } from "@workspace/api-client-react";
import { ActiveRequestGrid, activeCustomRequests } from "./ActiveRequestGrid";

function request(
  id: number,
  status: CustomRequest["status"],
  overrides: Partial<CustomRequest> = {},
): CustomRequest {
  return {
    id,
    type: "item",
    characterId: 10,
    characterName: "V",
    requestedById: "user-1",
    title: `Request ${id}`,
    status,
    createdAt: "2026-08-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("ActiveRequestGrid", () => {
  it("keeps actionable requests and hides terminal history", () => {
    const requests = [
      request(1, "draft"),
      request(2, "pending"),
      request(3, "changes_requested"),
      request(4, "approved"),
      request(5, "closed"),
      request(6, "cancelled"),
      request(7, "rejected"),
    ];

    expect(activeCustomRequests(requests).map((item) => item.id)).toEqual([1, 2, 3, 4]);
  });

  it("renders scalable cards with direct links to each request", () => {
    render(
      <ActiveRequestGrid
        requests={[
          request(11, "pending", { title: "Encrypted Agent" }),
          request(12, "changes_requested", {
            title: "Scrap Gatling Gun",
            type: "gun",
            reviewerNote: "Add a reference image.",
          }),
          request(13, "closed", { title: "Old request" }),
        ]}
      />,
    );

    expect(screen.getByText("Encrypted Agent")).toBeInTheDocument();
    expect(screen.getByText("Scrap Gatling Gun")).toBeInTheDocument();
    expect(screen.queryByText("Old request")).not.toBeInTheDocument();
    expect(screen.getByTestId("link-request-details-12")).toHaveAttribute(
      "href",
      "/submissions?focus=request-12",
    );
    expect(screen.getByText("Add a reference image.", { exact: false })).toBeInTheDocument();
  });

  it("renders nothing when only terminal requests remain", () => {
    const { container } = render(
      <ActiveRequestGrid requests={[request(20, "closed"), request(21, "rejected")]} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
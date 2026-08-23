import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ImageLightbox, type LightboxState } from "./ImageLightbox";

function Harness({ images, index = 0 }: { images: string[]; index?: number }) {
  const [state, setState] = useState<LightboxState>({ images, index });
  return <ImageLightbox state={state} onChange={setState} title="Test image" />;
}

describe("ImageLightbox", () => {
  it("shows the clicked image and pages left/right through the whole set with wrap-around", async () => {
    const user = userEvent.setup();
    render(<Harness images={["/a.png", "/b.png", "/c.png"]} />);

    const img = () => screen.getByTestId("img-lightbox-current");
    expect(img()).toHaveAttribute("src", "/a.png");
    expect(screen.getByTestId("text-lightbox-counter")).toHaveTextContent("1 / 3");

    await user.click(screen.getByTestId("button-lightbox-next"));
    expect(img()).toHaveAttribute("src", "/b.png");
    expect(screen.getByTestId("text-lightbox-counter")).toHaveTextContent("2 / 3");

    // Wraps around going backwards past the first image.
    await user.click(screen.getByTestId("button-lightbox-prev"));
    await user.click(screen.getByTestId("button-lightbox-prev"));
    expect(img()).toHaveAttribute("src", "/c.png");
    expect(screen.getByTestId("text-lightbox-counter")).toHaveTextContent("3 / 3");

    // Arrow keys navigate too (wraps forward to the first image).
    await user.keyboard("{ArrowRight}");
    expect(img()).toHaveAttribute("src", "/a.png");
    await user.keyboard("{ArrowLeft}");
    expect(img()).toHaveAttribute("src", "/c.png");
  });

  it("hides the navigation chrome for a single image", () => {
    render(<Harness images={["/only.png"]} />);
    expect(screen.getByTestId("img-lightbox-current")).toHaveAttribute("src", "/only.png");
    expect(screen.queryByTestId("button-lightbox-next")).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-lightbox-prev")).not.toBeInTheDocument();
    expect(screen.queryByTestId("text-lightbox-counter")).not.toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(<ImageLightbox state={null} onChange={() => {}} />);
    expect(screen.queryByTestId("dialog-image-lightbox")).not.toBeInTheDocument();
  });
});

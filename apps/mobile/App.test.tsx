import { render, screen } from "@testing-library/react-native";
import { PROTOCOL_VERSION } from "@coord/protocol";
import App from "./App";

describe("mobile App", () => {
  it("renders with workspace packages resolved", async () => {
    await render(<App />);
    expect(screen.getByText("Coord")).toBeTruthy();
    expect(screen.getByText(new RegExp(`protocol ${PROTOCOL_VERSION.replace(/\./g, "\\.")}`))).toBeTruthy();
  });
});

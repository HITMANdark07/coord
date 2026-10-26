import { Component, type ReactNode } from "react";
import { colors, space } from "@coord/design-tokens";
import { displayText } from "@coord/protocol";

/** Without this a render error leaves a blank window (PRD: never a blank screen). */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={{ padding: space.xl, color: colors.light.text }}>
        <h2>Something went wrong</h2>
        <p>{displayText(error.message)}</p>
        <button onClick={() => this.setState({ error: null })}>Reload</button>
      </div>
    );
  }
}

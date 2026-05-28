import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI crash captured by ErrorBoundary:", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-[300px] flex items-center justify-center p-8">
          <div className="border border-destructive bg-card/50 p-6 max-w-xl font-mono text-sm" data-testid="ui-error-boundary">
            <div className="text-destructive font-display tracking-widest text-lg mb-2">SYSTEM FAULT</div>
            <div className="text-muted-foreground mb-3">
              A component crashed while rendering. The rest of the app should still be usable.
            </div>
            <pre className="text-xs text-destructive bg-background border border-destructive/40 p-2 overflow-auto max-h-40">
              {this.state.error.message}
            </pre>
            <div className="flex gap-2 mt-4">
              <Button onClick={this.reset} className="rounded-none bg-nc-cyan text-background font-display">
                RETRY
              </Button>
              <Button
                variant="outline"
                onClick={() => window.location.reload()}
                className="rounded-none border-border font-display"
              >
                RELOAD
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

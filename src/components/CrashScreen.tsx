import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportStaleBuild, isStaleBuildError } from "../staleBuild";
import { flushAutosave } from "../hooks/useAutosave";

interface State {
  error: boolean;
  /** Reload pressed: waiting for the last save to reach the disk. */
  saving: boolean;
  /** That save failed; the next press reloads regardless. */
  saveFailed: boolean;
}

/**
 * The last line of defence: anything that throws while rendering lands here
 * instead of unmounting the app into an empty page. Before this existed, one
 * failure anywhere left a blank (in dark mode, black) screen with no way
 * forward and no word about the work.
 *
 * The work survives only where autosave keeps it — "Save session on this
 * device" on, and not a password-opened file — so the copy says exactly that.
 * Reload first writes any save still waiting on autosave's timer
 * (`flushAutosave` outlives the unmounted app), so the last edit isn't lost
 * to a reload inside that second.
 */
export class CrashScreen extends Component<{ children: ReactNode }, State> {
  state: State = { error: false, saving: false, saveFailed: false };

  static getDerivedStateFromError(): Partial<State> {
    return { error: true };
  }

  private reload = async () => {
    if (!this.state.saveFailed) {
      this.setState({ saving: true });
      const ok = await flushAutosave().catch(() => false);
      if (!ok) {
        this.setState({ saving: false, saveFailed: true });
        return;
      }
    }
    window.location.reload();
  };

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isStaleBuildError(error)) reportStaleBuild(error);
    // Kept for field reports: the screen is deliberately plain.
    console.error("The app stopped:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <h1 className="title-large">Something went wrong</h1>
          <p className="body-medium">
            The editor stopped unexpectedly. If “Save session on this device” is on, edited documents are
            offered back when you reload — except password-protected ones, which are never stored. Other
            files need opening again.
          </p>
          {this.state.saveFailed && (
            <p className="body-medium">Your latest edits couldn't be saved on this device.</p>
          )}
          <button className="btn btn--filled" onClick={this.reload} disabled={this.state.saving}>
            {this.state.saving ? "Saving…" : this.state.saveFailed ? "Reload anyway" : "Reload"}
          </button>
        </div>
      </div>
    );
  }
}

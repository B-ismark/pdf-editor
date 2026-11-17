import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportStaleBuild, isStaleBuildError } from "../staleBuild";

interface State {
  error: boolean;
}

/**
 * The last line of defence: anything that throws while rendering lands here
 * instead of unmounting the app into an empty page. Before this existed, one
 * failure anywhere left a blank (in dark mode, black) screen with no way
 * forward and no word about the work.
 *
 * The work itself survives without help from this screen: autosave writes
 * edited documents to this device on a timer that outlives the crash, and
 * reloading offers them back.
 */
export class CrashScreen extends Component<{ children: ReactNode }, State> {
  state: State = { error: false };

  static getDerivedStateFromError(): State {
    return { error: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isStaleBuildError(error)) reportStaleBuild();
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
            The editor stopped unexpectedly. Edited documents are saved on this device and are offered back
            when you reload. A file you hadn't changed needs opening again.
          </p>
          <button className="btn btn--filled" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

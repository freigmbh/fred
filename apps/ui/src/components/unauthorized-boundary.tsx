import { Component, type ReactNode } from "react";
import { errorText, signOutIfRejected } from "@/lib/admin";

type Props = { children: ReactNode };
type State = { error: Error | null };

// Catches errors thrown while rendering a page, such as failed admin queries. A rejected secret logs out; anything else shows
// as one line until the boundary remounts. Key it by secret and page so a new login or another page starts clean.
export class UnauthorizedBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error) {
    signOutIfRejected(error);
  }

  override render() {
    if (this.state.error) return <p className="px-6 py-5 text-bordeaux">{errorText(this.state.error)}</p>;
    return this.props.children;
  }
}

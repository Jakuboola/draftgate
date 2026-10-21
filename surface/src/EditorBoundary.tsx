import { Component, type ReactNode } from 'react';

/**
 * Catches a document TipTap refuses to load and hands the error UP through `onError`: rendering it
 * here would leave the approve button mounted beside it, and only the caller can remove the footer.
 * `toEditorDoc` should make this unreachable, but a render-phase throw must not blank the window.
 * Its own module because a patch's previews (`PatchEdits.tsx`) sit in one each.
 */
export interface EditorBoundaryProps {
  children: ReactNode;
  onError(error: Error): void;
}

export class EditorBoundary extends Component<EditorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

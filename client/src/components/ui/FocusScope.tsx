import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

const TABBABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  "audio[controls]",
  "video[controls]",
  "summary",
  '[contenteditable]:not([contenteditable="false"])',
  "[tabindex]",
].join(",");

function isRendered(element: Element, container: Element | null = null): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (
      current.hasAttribute("hidden") ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden"
    ) {
      return false;
    }

    if (current instanceof HTMLDetailsElement && !current.open) {
      const summary = Array.from(current.children).find(
        (child) => child.tagName === "SUMMARY",
      );
      if (!summary?.contains(element)) return false;
    }
    if (current === container) break;
  }
  return true;
}

function isRadioGroupTabStop(
  element: HTMLElement,
  candidates: HTMLElement[],
): boolean {
  if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) {
    return true;
  }

  const group = candidates.filter(
    (candidate): candidate is HTMLInputElement =>
      candidate instanceof HTMLInputElement &&
      candidate.type === "radio" &&
      candidate.name === element.name &&
      candidate.form === element.form,
  );
  return element === (group.find((radio) => radio.checked) ?? group[0]);
}

function isEffectivelyDisabled(element: Element): boolean {
  if (element.matches(":disabled")) return true;

  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName !== "FIELDSET" || !ancestor.hasAttribute("disabled")) continue;
    const firstLegend = Array.from(ancestor.children).find(
      (child) => child.tagName === "LEGEND",
    );
    if (!firstLegend?.contains(element)) return true;
  }
  return false;
}

function isEmbeddedBrowsingContext(element: Element): boolean {
  // Keyboard events from an embedded document cannot reach this React-owned
  // containment authority, so admitting it would create a one-way Tab escape.
  return element.matches("iframe, object, embed");
}

function tabbableElements(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !isEmbeddedBrowsingContext(element) &&
      !isEffectivelyDisabled(element) &&
      isRendered(element, container),
  );

  return candidates
    .filter((element) => isRadioGroupTabStop(element, candidates))
    .map((element, documentOrder) => ({ element, documentOrder }))
    .sort((left, right) => {
      const leftTabIndex = left.element.tabIndex;
      const rightTabIndex = right.element.tabIndex;
      if (leftTabIndex > 0 || rightTabIndex > 0) {
        if (leftTabIndex === rightTabIndex) {
          return left.documentOrder - right.documentOrder;
        }
        if (leftTabIndex === 0) return 1;
        if (rightTabIndex === 0) return -1;
        return leftTabIndex - rightTabIndex;
      }
      return left.documentOrder - right.documentOrder;
    })
    .map(({ element }) => element);
}

type LayerId = symbol;
type ScopeId = symbol;
type FocusTarget = HTMLElement | SVGElement;
type FocusCandidate = () => FocusTarget | null;

function isFocusTargetAvailable(
  target: FocusTarget | null | undefined,
): target is FocusTarget {
  return Boolean(
    target?.isConnected &&
      !(target instanceof HTMLInputElement && target.type === "hidden") &&
      !isEffectivelyDisabled(target) &&
      isRendered(target),
  );
}

function tryFocusTarget(target: FocusTarget | null | undefined): boolean {
  if (!isFocusTargetAvailable(target)) return false;
  try {
    target.focus();
  } catch {
    return false;
  }
  return document.activeElement === target;
}

interface ScopeLayer {
  kind: "scope";
  id: LayerId;
  scopeId: ScopeId;
  parentScopeId: ScopeId | null;
  depth: number;
  sequence: number;
  container: HTMLElement;
  owner: HTMLElement;
  restoreCandidates: FocusCandidate[];
  onEscape: () => void;
}

interface PortalBranchLayer {
  kind: "portal-branch";
  id: LayerId;
  parentScopeId: ScopeId;
  depth: number;
  sequence: number;
  container: HTMLElement;
  owner: HTMLElement;
  anchor: HTMLElement | null;
  onDismiss: () => void;
}

type FocusLayer = ScopeLayer | PortalBranchLayer;

interface ScopeRegistration {
  scopeId: ScopeId;
  parentScopeId: ScopeId | null;
  depth: number;
  container: HTMLElement;
  owner: HTMLElement;
  resolveReturnFocusTarget: FocusCandidate;
  onEscape: () => void;
}

interface PortalBranchRegistration {
  parentScopeId: ScopeId;
  depth: number;
  container: HTMLElement;
  owner: HTMLElement;
  anchor: HTMLElement | null;
  onDismiss: () => void;
}

interface FocusScopeManager {
  registerScope: (registration: ScopeRegistration) => () => void;
  registerPortalBranch: (registration: PortalBranchRegistration) => () => void;
  handleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  focusInitial: (scopeId: ScopeId, target: HTMLElement | null) => void;
  flushRestoration: () => void;
}

function activeElement(): FocusTarget | null {
  const focused = document.activeElement;
  return focused instanceof HTMLElement || focused instanceof SVGElement
    ? focused
    : null;
}

function createFocusScopeManager(): FocusScopeManager {
  let layers: FocusLayer[] = [];
  let sequence = 0;
  // Layout cleanup records ownership before portal nodes disappear. Passive
  // cleanup restores afterward so React's commit-time focus preservation
  // cannot pull focus back into an exiting Framer Motion element.
  let pendingRestorations: Array<{
    depth: number;
    sequence: number;
    candidates: FocusCandidate[];
    fallback: HTMLElement | null;
    ownedRoots: HTMLElement[];
    parentScopeId: ScopeId | null;
  }> = [];

  const connectedLayers = () => {
    layers = layers.filter(
      (layer) => layer.container.isConnected && layer.owner.isConnected,
    );
    return layers;
  };

  const scopeLayer = (scopeId: ScopeId) =>
    layers.find(
      (layer): layer is ScopeLayer =>
        layer.kind === "scope" && layer.scopeId === scopeId,
    );

  const hasRegisteredAncestorChain = (layer: FocusLayer) => {
    const visited = new Set<ScopeId>();
    let parentScopeId = layer.parentScopeId;
    while (parentScopeId) {
      if (visited.has(parentScopeId)) return false;
      visited.add(parentScopeId);
      const parent = scopeLayer(parentScopeId);
      if (!parent?.container.isConnected || !parent.owner.isConnected) {
        return false;
      }
      parentScopeId = parent.parentScopeId;
    }
    return true;
  };

  // An exiting portaled child may outlive its parent in the DOM. Keep its
  // registration for a canceled exit, but do not let an orphan own keys/focus.
  const activeLayers = () =>
    connectedLayers().filter(hasRegisteredAncestorChain);

  const isDescendantOfScope = (layer: FocusLayer, scopeId: ScopeId) => {
    let parentScopeId = layer.parentScopeId;
    while (parentScopeId) {
      if (parentScopeId === scopeId) return true;
      parentScopeId = scopeLayer(parentScopeId)?.parentScopeId ?? null;
    }
    return false;
  };

  const layerContainsTarget = (
    layer: FocusLayer,
    target: FocusTarget | null,
  ) => {
    if (!target) return false;
    if (layer.owner.contains(target)) return true;
    if (layer.kind !== "scope") return false;
    return layers.some(
      (candidate) =>
        candidate.id !== layer.id &&
        isDescendantOfScope(candidate, layer.scopeId) &&
        candidate.owner.contains(target),
    );
  };

  const layerOwnsFocus = (layer: FocusLayer, focused: FocusTarget | null) =>
    focused === document.body || layerContainsTarget(layer, focused);

  const unregister = (layer: FocusLayer) => {
    const focused = activeElement();
    const shouldRestore = layerOwnsFocus(layer, focused);
    const ownedRoots = [
      layer.owner,
      ...(layer.kind === "scope"
        ? layers
            .filter((candidate) => isDescendantOfScope(candidate, layer.scopeId))
            .map((candidate) => candidate.owner)
        : []),
    ];
    const parent = layer.parentScopeId
      ? scopeLayer(layer.parentScopeId)
      : null;
    layers = layers.filter((candidate) => candidate.id !== layer.id);

    const candidates =
      layer.kind === "scope"
        ? layer.restoreCandidates
        : [() => layer.anchor];
    if (shouldRestore) {
      pendingRestorations.push({
        depth: layer.depth,
        sequence: layer.sequence,
        candidates,
        fallback: parent?.container ?? null,
        ownedRoots,
        parentScopeId: parent?.scopeId ?? null,
      });
    }
  };

  const restorationForFocus = (
    focused: FocusTarget | null,
    preferredParentScopeId: ScopeId | null = null,
  ) => {
    const ordered = [...pendingRestorations]
      .sort(
        (left, right) =>
          left.depth - right.depth || left.sequence - right.sequence,
      );
    if (focused === null || focused === document.body) {
      return (
        (preferredParentScopeId
          ? ordered.find(
              (restoration) =>
                restoration.parentScopeId === preferredParentScopeId,
            )
          : null) ??
        ordered[0] ??
        null
      );
    }
    return (
      ordered.find((restoration) =>
        restoration.ownedRoots.some((owner) => owner.contains(focused)),
      ) ?? null
    );
  };

  const registerScope = (registration: ScopeRegistration) => {
    const { resolveReturnFocusTarget, ...layerRegistration } = registration;
    const focused = activeElement();
    // Preserve the original return path when StrictMode or a same-commit
    // successor scope registers before passive restoration can run.
    const inheritedCandidates =
      restorationForFocus(focused, registration.parentScopeId)?.candidates ??
      [];
    const layer: ScopeLayer = {
      kind: "scope",
      id: Symbol("focus-scope-layer"),
      ...layerRegistration,
      sequence: sequence++,
      restoreCandidates: [
        ...inheritedCandidates,
        resolveReturnFocusTarget,
        () => focused,
      ],
    };
    layers.push(layer);
    return () => unregister(layer);
  };

  const registerPortalBranch = (registration: PortalBranchRegistration) => {
    const layer: PortalBranchLayer = {
      kind: "portal-branch",
      id: Symbol("focus-portal-branch"),
      ...registration,
      sequence: sequence++,
    };
    layers.push(layer);
    return () => unregister(layer);
  };

  const topLayerFrom = (candidates: FocusLayer[]) =>
    candidates.reduce<FocusLayer | null>((top, candidate) => {
      if (!top || candidate.depth > top.depth) return candidate;
      if (candidate.depth === top.depth && candidate.sequence > top.sequence) {
        return candidate;
      }
      return top;
    }, null);

  const topLayer = () => topLayerFrom(activeLayers());

  const focusLayerFallback = (layer: FocusLayer) => {
    for (const candidate of tabbableElements(layer.container)) {
      if (tryFocusTarget(candidate)) return true;
    }
    return tryFocusTarget(layer.container);
  };

  const focusWithin = (
    event: ReactKeyboardEvent<HTMLElement>,
    container: HTMLElement,
  ) => {
    const tabbable = tabbableElements(container);
    event.preventDefault();
    if (tabbable.length === 0) {
      container.focus();
      return;
    }

    const currentIndex = tabbable.findIndex(
      (element) => element === document.activeElement,
    );
    const nextIndex =
      currentIndex === -1
        ? event.shiftKey
          ? tabbable.length - 1
          : 0
        : (currentIndex + (event.shiftKey ? -1 : 1) + tabbable.length) %
          tabbable.length;
    tabbable[nextIndex].focus();
  };

  const focusAdjacentToAnchor = (
    container: HTMLElement,
    anchor: HTMLElement | null,
    backwards: boolean,
  ) => {
    const tabbable = tabbableElements(container);
    if (tabbable.length === 0) {
      container.focus();
      return;
    }

    const anchorIndex = anchor ? tabbable.indexOf(anchor) : -1;
    const nextIndex =
      anchorIndex === -1
        ? backwards
          ? tabbable.length - 1
          : 0
        : (anchorIndex + (backwards ? -1 : 1) + tabbable.length) %
          tabbable.length;
    tabbable[nextIndex].focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    const active = activeLayers();
    if (
      !(target instanceof Node) ||
      !active.some((layer) => layer.owner.contains(target))
    ) {
      return;
    }
    const top = topLayerFrom(active);
    if (!top) return;

    if (event.key === "Escape") {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (top.kind === "portal-branch") top.onDismiss();
      else top.onEscape();
      return;
    }
    if (event.key !== "Tab") return;

    event.stopPropagation();
    if (top.kind === "portal-branch") {
      event.preventDefault();
      const parent = scopeLayer(top.parentScopeId);
      // A popup is logically adjacent to its trigger even though its portal is
      // appended after the app root. Advance from that anchor, then dismiss.
      if (parent) {
        focusAdjacentToAnchor(parent.container, top.anchor, event.shiftKey);
      }
      top.onDismiss();
      return;
    }
    focusWithin(event, top.container);
  };

  const focusInitial = (scopeId: ScopeId, target: HTMLElement | null) => {
    const top = topLayer();
    if (
      top?.kind === "scope" &&
      top.scopeId === scopeId
    ) {
      if (!tryFocusTarget(target)) tryFocusTarget(top.container);
    }
  };

  const flushRestoration = () => {
    if (pendingRestorations.length === 0) return;
    const top = topLayer();
    const restoration = restorationForFocus(
      activeElement(),
      top?.kind === "scope" ? top.scopeId : null,
    );
    pendingRestorations = [];
    if (!restoration) return;

    const topIsResumedParent =
      top?.kind === "scope" &&
      restoration.parentScopeId === top.scopeId;
    const attempted = new Set<FocusTarget>();
    const focusCandidates = (requiredOwner: FocusLayer | null) => {
      for (const resolveCandidate of restoration.candidates) {
        let candidate: FocusTarget | null;
        try {
          candidate = resolveCandidate();
        } catch {
          continue;
        }
        if (!candidate || attempted.has(candidate)) continue;
        attempted.add(candidate);
        if (requiredOwner && !layerContainsTarget(requiredOwner, candidate)) {
          continue;
        }
        if (tryFocusTarget(candidate)) return true;
      }
      return false;
    };

    // Any surviving layer remains the focus authority. Candidates and stored
    // fallbacks may be stale, so never let either move focus outside that top
    // layer while it is active.
    if (top) {
      if (focusCandidates(top)) return;
      if (
        topIsResumedParent &&
        layerContainsTarget(top, restoration.fallback) &&
        tryFocusTarget(restoration.fallback)
      ) {
        return;
      }
      focusLayerFallback(top);
      return;
    }

    focusCandidates(null);
  };

  return {
    registerScope,
    registerPortalBranch,
    handleKeyDown,
    focusInitial,
    flushRestoration,
  };
}

interface FocusScopeContextValue {
  manager: FocusScopeManager;
  scopeId: ScopeId;
  depth: number;
}

const FocusScopeContext = createContext<FocusScopeContextValue | null>(null);

interface FocusScopeRenderProps {
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

interface FocusScopeProps {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  ownerRef?: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Stable destination used when pointer activation does not move focus. */
  returnFocusRef?: RefObject<FocusTarget | null>;
  onEscape: () => void;
  children: (props: FocusScopeRenderProps) => ReactNode;
}

/**
 * Renderless keyboard/focus authority for a modal surface. Nested scopes share
 * one manager, so only the deepest active dialog owns Tab and Escape even when
 * React portals place its DOM outside the parent panel.
 */
export function FocusScope({
  active,
  containerRef,
  ownerRef = containerRef,
  initialFocusRef,
  returnFocusRef,
  onEscape,
  children,
}: FocusScopeProps) {
  const parent = useContext(FocusScopeContext);
  const ownedManager = useMemo(() => createFocusScopeManager(), []);
  const manager = parent?.manager ?? ownedManager;
  const scopeId = useRef<ScopeId>(Symbol("focus-scope")).current;
  const depth = (parent?.depth ?? -1) + 1;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const returnFocusRefRef = useRef(returnFocusRef);
  returnFocusRefRef.current = returnFocusRef;

  useLayoutEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const owner = ownerRef.current;
    if (!container || !owner) return;
    return manager.registerScope({
      scopeId,
      parentScopeId: parent?.scopeId ?? null,
      depth,
      container,
      owner,
      resolveReturnFocusTarget: () =>
        returnFocusRefRef.current?.current ?? null,
      onEscape: () => onEscapeRef.current(),
    });
  }, [
    active,
    containerRef,
    depth,
    manager,
    ownerRef,
    parent?.scopeId,
    scopeId,
  ]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      manager.focusInitial(
        scopeId,
        initialFocusRef?.current ?? containerRef.current,
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      manager.flushRestoration();
    };
  }, [active, containerRef, initialFocusRef, manager, scopeId]);

  const context = useMemo(
    () => ({ manager, scopeId, depth }),
    [depth, manager, scopeId],
  );

  return (
    <FocusScopeContext.Provider value={context}>
      {children({ onKeyDown: manager.handleKeyDown })}
    </FocusScopeContext.Provider>
  );
}

interface UseFocusScopePortalBranchOptions {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  ownerRef?: RefObject<HTMLElement | null>;
  anchorRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}

/** Registers a portaled popup at its trigger's logical position in a scope. */
// This hook must share the component's private context so a branch registers
// with the exact manager that owns its nearest scope.
// eslint-disable-next-line react-refresh/only-export-components
export function useFocusScopePortalBranch({
  active,
  containerRef,
  ownerRef = containerRef,
  anchorRef,
  onDismiss,
}: UseFocusScopePortalBranchOptions) {
  const scope = useContext(FocusScopeContext);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useLayoutEffect(() => {
    if (!active || !scope) return;
    const container = containerRef.current;
    const owner = ownerRef.current;
    if (!container || !owner) return;
    return scope.manager.registerPortalBranch({
      parentScopeId: scope.scopeId,
      depth: scope.depth + 1,
      container,
      owner,
      anchor: anchorRef.current,
      onDismiss: () => onDismissRef.current(),
    });
  }, [active, anchorRef, containerRef, ownerRef, scope]);

  useEffect(() => {
    if (!active || !scope) return;
    return () => scope.manager.flushRestoration();
  }, [active, scope]);
}

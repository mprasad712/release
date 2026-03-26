import { useEffect, useRef } from "react";
import { useLogout, useRefreshAccessToken } from "@/controllers/API/queries/auth";
import { CustomNavigate } from "@/customization/components/custom-navigate";
import { customGetAccessToken } from "@/customization/utils/custom-get-access-token";
import useAuthStore from "@/stores/authStore";

const TOKEN_REFRESH_BUFFER_SECONDS = 15;
const MIN_TOKEN_REFRESH_SECONDS = 5;
const FALLBACK_REFRESH_SECONDS = 60;
const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  "mousedown",
  "mousemove",
  "keydown",
  "scroll",
  "touchstart",
  "click",
];

const getAccessTokenPayload = (
  token: string | undefined,
): { exp?: number; iat?: number } | null => {
  if (!token) return null;

  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) {
      return null;
    }

    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
};

const getAccessTokenExpEpoch = (token: string | undefined): number | null => {
  const payload = getAccessTokenPayload(token);
  return typeof payload?.exp === "number" ? payload.exp : null;
};

const getSessionLifetimeSeconds = (token: string | undefined): number => {
  const payload = getAccessTokenPayload(token);
  if (
    typeof payload?.exp === "number" &&
    typeof payload?.iat === "number" &&
    payload.exp > payload.iat
  ) {
    return payload.exp - payload.iat;
  }

  const exp = typeof payload?.exp === "number" ? payload.exp : null;
  const now = Math.floor(Date.now() / 1000);
  return exp && exp > now ? exp - now : FALLBACK_REFRESH_SECONDS;
};

export const ProtectedRoute = ({ children }) => {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const { mutate: mutateRefresh } = useRefreshAccessToken();
  const { mutate: mutateLogout } = useLogout();
  const lastActivityAtRef = useRef<number>(Date.now());
  const refreshInFlightRef = useRef(false);

  
  const testMockAutoLogin = sessionStorage.getItem("testMockAutoLogin");

  const shouldRedirect =
    !isAuthenticated

  useEffect(() => {
    if (!isAuthenticated) return;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const clearScheduledRefresh = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const logoutStaleSession = () => {
      if (cancelled) return;
      clearScheduledRefresh();
      mutateLogout(undefined);
    };

    const markActivity = () => {
      lastActivityAtRef.current = Date.now();
    };

    const getIdleTimeoutMs = () => {
      const currentToken = customGetAccessToken();
      return Math.max(
        MIN_TOKEN_REFRESH_SECONDS * 1000,
        getSessionLifetimeSeconds(currentToken) * 1000,
      );
    };

    const isPastIdleTimeout = () => {
      const idleForMs = Date.now() - lastActivityAtRef.current;
      return idleForMs >= getIdleTimeoutMs();
    };

    const refreshSession = () => {
      if (cancelled || refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;

      mutateRefresh(undefined, {
        onSuccess: () => {
          refreshInFlightRef.current = false;
          if (!cancelled) {
            markActivity();
            scheduleRefresh();
          }
        },
        onError: () => {
          refreshInFlightRef.current = false;
          logoutStaleSession();
        },
      });
    };

    const scheduleRefresh = () => {
      if (cancelled) return;
      clearScheduledRefresh();

      const currentToken = customGetAccessToken();
      const tokenExp = getAccessTokenExpEpoch(currentToken);
      const now = Math.floor(Date.now() / 1000);
      const secondsUntilExpiry = tokenExp ? tokenExp - now : null;

      const nextRefreshInSeconds =
        secondsUntilExpiry === null
          ? FALLBACK_REFRESH_SECONDS
          : Math.max(
              MIN_TOKEN_REFRESH_SECONDS,
              secondsUntilExpiry - TOKEN_REFRESH_BUFFER_SECONDS,
            );

      timeoutId = setTimeout(() => {
        if (isPastIdleTimeout()) {
          logoutStaleSession();
          return;
        }

        refreshSession();
      }, nextRefreshInSeconds * 1000);
    };

    const refreshIfNeeded = (treatAsActivity: boolean) => {
      if (cancelled) return;
      if (treatAsActivity) {
        markActivity();
      }

      if (isPastIdleTimeout()) {
        logoutStaleSession();
        return;
      }

      const currentToken = customGetAccessToken();
      const tokenExp = getAccessTokenExpEpoch(currentToken);
      const now = Math.floor(Date.now() / 1000);
      const secondsUntilExpiry = tokenExp ? tokenExp - now : null;

      if (secondsUntilExpiry === null || secondsUntilExpiry <= TOKEN_REFRESH_BUFFER_SECONDS) {
        refreshSession();
        return;
      }

      scheduleRefresh();
    };

    const onFocus = () => {
      refreshIfNeeded(false);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshIfNeeded(false);
      }
    };

    markActivity();
    scheduleRefresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    ACTIVITY_EVENTS.forEach((eventName) => {
      window.addEventListener(eventName, markActivity, { passive: true });
    });

    return () => {
      cancelled = true;
      clearScheduledRefresh();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ACTIVITY_EVENTS.forEach((eventName) => {
        window.removeEventListener(eventName, markActivity);
      });
    };
  }, [isAuthenticated, mutateLogout, mutateRefresh]);

  if (shouldRedirect || testMockAutoLogin) {
    const currentPath = window.location.pathname;
    const isHomePath = currentPath === "/" || currentPath === "/agents";
    const isLoginPage = location.pathname.includes("login");
    return (
      <CustomNavigate
        to={
          "/login" +
          (!isHomePath && !isLoginPage ? "?redirect=" + currentPath : "")
        }
        replace
      />
    );
  } else {
    return children;
  }
};

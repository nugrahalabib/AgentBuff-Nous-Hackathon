"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  GatewayClient,
  type GatewayEvent,
} from "@/lib/hermes/browser-gateway";

type GatewayStatus = "connecting" | "ready" | "disconnected" | "error";

interface GatewayContextValue {
  client: GatewayClient | null;
  status: GatewayStatus;
  lastError: string | null;
}

const GatewayContext = createContext<GatewayContextValue>({
  client: null,
  status: "disconnected",
  lastError: null,
});

export function BridgeProvider({ children }: { children: React.ReactNode }) {
  const clientRef = useRef<GatewayClient | null>(null);
  const [status, setStatus] = useState<GatewayStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    const client = new GatewayClient({
      onOpen: () => setStatus("connecting"),
      onReady: () => {
        setStatus("ready");
        setLastError(null);
      },
      onClose: (info) => {
        setStatus("disconnected");
        if (info.code !== 1000) {
          setLastError(info.reason || `code ${info.code}`);
        }
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, []);

  const value = useMemo<GatewayContextValue>(
    () => ({ client: clientRef.current, status, lastError }),
    [status, lastError],
  );

  return (
    <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
  );
}

export function useGateway(): GatewayContextValue {
  return useContext(GatewayContext);
}

/**
 * Subscribe to gateway events for the lifetime of the component.
 * Automatically unsubscribes on unmount.
 */
export function useGatewayEvent(
  handler: (evt: GatewayEvent) => void,
  deps: React.DependencyList = [],
) {
  const { client } = useGateway();
  useEffect(() => {
    if (!client) return;
    const off = client.onEvent(handler);
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ...deps]);
}

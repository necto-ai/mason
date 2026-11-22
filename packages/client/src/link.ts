import { type Link, type WebSocketLike, webSocketLink } from "@earendil-works/chord";
import type { LinkFactory } from "./connector.ts";

export type WebSocketConstructor = new (url: string, options?: unknown) => WebSocketLike;

export function nodeWebSocketLink(WebSocketImpl: WebSocketConstructor): LinkFactory {
	return (url, init): Link => {
		const socket = new WebSocketImpl(url, { headers: { authorization: `Bearer ${init.credential}` } });
		const link = webSocketLink(socket);
		socket.addEventListener("error", () => link.close("the connection failed"));
		return link;
	};
}

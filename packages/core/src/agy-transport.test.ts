import * as net from "node:net"

import { afterEach, describe, expect, it } from "vitest"

import {
  ContentLengthStream,
  DEFAULT_AGY_IDLE_TIMEOUT_MS,
  DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS,
  fetchWithAgyCliTransport,
} from "./agy-transport.ts"

const savedProxyEnv = {
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  ALL_PROXY: process.env.ALL_PROXY,
  all_proxy: process.env.all_proxy,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
}

function restoreProxyEnv(): void {
  for (const [key, value] of Object.entries(savedProxyEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function collect(stream: ContentLengthStream, inputs: Buffer[]): Promise<Buffer> {
  const chunks: Buffer[] = []
  stream.on("data", (c: Buffer) => chunks.push(c))
  const done = new Promise<void>((resolve) => stream.on("end", resolve))
  for (const input of inputs) stream.write(input)
  stream.end()
  await done
  return Buffer.concat(chunks)
}

describe("agy transport", () => {
  afterEach(() => {
    restoreProxyEnv()
  })

  it("has bounded default header and idle timeouts", () => {
    expect(DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS).toBe(180_000)
    expect(DEFAULT_AGY_IDLE_TIMEOUT_MS).toBe(180_000)
  })

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchWithAgyCliTransport("https://example.com/x", { method: "POST" }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i)
  })

  it("times out while waiting for response headers", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        // Accept the connection but never respond.
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no port")

    process.env.HTTPS_PROXY = `http://127.0.0.1:${address.port}`
    delete process.env.https_proxy
    delete process.env.ALL_PROXY
    delete process.env.all_proxy
    delete process.env.NO_PROXY
    delete process.env.no_proxy

    const debugLines: string[] = []
    try {
      await expect(fetchWithAgyCliTransport("https://example.com/v1internal:streamGenerateContent", {
        method: "POST",
        headers: { "User-Agent": "antigravity/cli/1.0.4 darwin/arm64" },
        body: JSON.stringify({ x: 1 }),
      }, {
        timeoutMs: 20,
        onDebug: (line) => debugLines.push(line),
      })).rejects.toThrow("Antigravity request timed out waiting for response headers after 20ms")

      expect(debugLines.some((l) => l.includes("proxy CONNECT response timeout after 20ms"))).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  })

  describe("ContentLengthStream", () => {
    it("emits exactly contentLength bytes and ends", async () => {
      const out = await collect(new ContentLengthStream(5), [Buffer.from("hello")])
      expect(out.toString()).toBe("hello")
    })

    it("discards trailing bytes belonging to the next keep-alive response", async () => {
      const out = await collect(new ContentLengthStream(5), [Buffer.from("helloEXTRA_NEXT_RESPONSE")])
      expect(out.toString()).toBe("hello")
    })

    it("reassembles a body split across chunks", async () => {
      const out = await collect(new ContentLengthStream(6), [Buffer.from("foo"), Buffer.from("bar"), Buffer.from("baz")])
      expect(out.toString()).toBe("foobar")
    })
  })
})

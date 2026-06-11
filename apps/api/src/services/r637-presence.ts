/**
 * R637 — Operator presence (J2).
 *
 * WS /ws/presence — clients announce themselves with a name + cursor,
 * server broadcasts the roster to all connected clients in the same
 * workspace. Used to power "Alice is viewing /ops/kg" indicators.
 *
 * Wire-protocol:
 *   client→server  json  { type: 'hello',     name, color?, route? }
 *   client→server  json  { type: 'heartbeat', route?, cursor? }
 *   client→server  json  { type: 'bye' }
 *   server→client  json  { type: 'roster', peers: [{id,name,color,route,lastSeen}] }
 *
 * Stale peers (>15s no heartbeat) are pruned on each broadcast. No DB
 * involvement — pure in-memory.
 */
import type { WebSocket } from 'ws'

interface Peer {
  id:        string
  name:      string
  color:     string
  route?:    string
  cursor?:   { x: number; y: number }
  lastSeen:  number
  ws:        WebSocket
}

const ROOMS = new Map<string, Map<string, Peer>>()    // workspaceId → peerId → Peer
const STALE_MS = 15_000

function getRoom(workspaceId: string): Map<string, Peer> {
  let r = ROOMS.get(workspaceId)
  if (!r) { r = new Map(); ROOMS.set(workspaceId, r) }
  return r
}

function pruneStale(room: Map<string, Peer>): void {
  const cutoff = Date.now() - STALE_MS
  for (const [id, p] of room) {
    if (p.lastSeen < cutoff || p.ws.readyState !== 1) room.delete(id)
  }
}

function broadcastRoster(workspaceId: string): void {
  const room = getRoom(workspaceId)
  pruneStale(room)
  const peers = [...room.values()].map(p => {
    const out: { id: string; name: string; color: string; route?: string; cursor?: { x: number; y: number }; lastSeen: number } = {
      id: p.id, name: p.name, color: p.color, lastSeen: p.lastSeen,
    }
    if (p.route)  out.route  = p.route
    if (p.cursor) out.cursor = p.cursor
    return out
  })
  const payload = JSON.stringify({ type: 'roster', peers })
  for (const p of room.values()) {
    if (p.ws.readyState === 1) {
      try { p.ws.send(payload) } catch { /* socket dying */ }
    }
  }
}

let idSeq = 0
function makeId(): string { return `peer_${Date.now().toString(36)}_${(idSeq++).toString(36)}` }

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899']

export function attachPresenceSession(ws: WebSocket, workspaceId: string): void {
  const id = makeId()
  const peer: Peer = {
    id, name: id.slice(-6), color: COLORS[idSeq % COLORS.length] ?? '#6b7280',
    lastSeen: Date.now(), ws,
  }
  const room = getRoom(workspaceId)
  room.set(id, peer)
  try { ws.send(JSON.stringify({ type: 'welcome', id, color: peer.color })) } catch { /* ignore */ }
  broadcastRoster(workspaceId)

  ws.on('message', (data: Buffer | string) => {
    const p = room.get(id)
    if (!p) return
    let msg: Record<string, unknown> = {}
    try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) } catch { return }
    switch (msg['type']) {
      case 'hello': {
        if (typeof msg['name']  === 'string') p.name  = String(msg['name']).slice(0, 40)
        if (typeof msg['color'] === 'string') p.color = String(msg['color']).slice(0, 16)
        if (typeof msg['route'] === 'string') p.route = String(msg['route']).slice(0, 200)
        p.lastSeen = Date.now()
        broadcastRoster(workspaceId)
        return
      }
      case 'heartbeat': {
        p.lastSeen = Date.now()
        if (typeof msg['route'] === 'string') p.route = String(msg['route']).slice(0, 200)
        const cur = msg['cursor'] as { x?: number; y?: number } | undefined
        if (cur && typeof cur.x === 'number' && typeof cur.y === 'number') p.cursor = { x: cur.x, y: cur.y }
        broadcastRoster(workspaceId)
        return
      }
      case 'bye': {
        room.delete(id)
        broadcastRoster(workspaceId)
        return
      }
    }
  })

  ws.on('close', () => { room.delete(id); broadcastRoster(workspaceId) })
  ws.on('error', () => { room.delete(id); broadcastRoster(workspaceId) })
}

export function presenceStats(): { rooms: number; totalPeers: number; byWorkspace: Record<string, number> } {
  const byWorkspace: Record<string, number> = {}
  let total = 0
  // Snapshot keys first; deleting during iteration is undefined behavior.
  for (const ws of [...ROOMS.keys()]) {
    const room = ROOMS.get(ws)
    if (!room) continue
    pruneStale(room)
    if (room.size === 0) { ROOMS.delete(ws); continue }   // GC empty rooms — don't report ghosts
    byWorkspace[ws] = room.size
    total += room.size
  }
  return { rooms: ROOMS.size, totalPeers: total, byWorkspace }
}

export function presenceRoster(workspaceId: string): Array<{ id: string; name: string; color: string; route?: string; lastSeen: number }> {
  // Read-only — do not lazy-create.
  const room = ROOMS.get(workspaceId)
  if (!room) return []
  pruneStale(room)
  return [...room.values()].map(p => {
    const out: { id: string; name: string; color: string; route?: string; lastSeen: number } = {
      id: p.id, name: p.name, color: p.color, lastSeen: p.lastSeen,
    }
    if (p.route) out.route = p.route
    return out
  })
}

/**
 * Signaling via WebSocket trackers
 *
 * Uses existing WebTorrent tracker infrastructure for WebRTC signaling.
 * The bootstrap process:
 * 1. Connect to a WebSocket tracker
 * 2. Announce a well-known "bootstrap info hash" to find other DHT nodes
 * 3. Exchange SDP offers/answers through the tracker
 * 4. Establish direct WebRTC connections
 *
 * The tracker protocol is simple:
 * - Client sends: { action: 'announce', info_hash, peer_id, offers: [...] }
 * - Tracker sends back: { action: 'announce', offer, peer_id, info_hash }
 *   for each peer that wants to connect
 * - Client responds with an answer through the tracker
 */

import { EventEmitter } from 'events'
import { sha1, toHex, randomId } from '../kademlia/id.js'

// Well-known bootstrap hash — all DHT nodes announce this to find each other
const BOOTSTRAP_NAMESPACE = 'webrtc-dht-bootstrap-v1'

export class SignalingClient extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string[]} opts.trackers - WebSocket tracker URLs
   * @param {Uint8Array} opts.nodeId - our DHT node ID (used as peer_id)
   * @param {number} [opts.announceInterval=30000] - re-announce interval in ms
   * @param {number} [opts.numOffers=5] - number of SDP offers to generate per announce
   */
  constructor (opts) {
    super()
    this.trackers = opts.trackers || ['wss://tracker.openwebtorrent.com']
    this.nodeId = opts.nodeId
    this.announceInterval = opts.announceInterval || 30000
    this.numOffers = opts.numOffers || 5

    this._sockets = new Map()
    this._bootstrapHash = null
    this._announceTimers = []
    this._destroyed = false

    // Pending offers: offerId -> { resolve, reject } for SDP answers
    this._pendingOffers = new Map()
  }

  /**
   * Start the signaling client — connect to trackers and begin announcing
   * @param {Function} createOffer - async function that returns { offerId, sdpOffer }
   * @param {Function} createAnswer - async function(sdpOffer) that returns { sdpAnswer }
   */
  async start (createOffer, createAnswer) {
    this._createOffer = createOffer
    this._createAnswer = createAnswer

    // Compute the bootstrap info hash
    this._bootstrapHash = await sha1(BOOTSTRAP_NAMESPACE)

    for (const url of this.trackers) {
      this._connectTracker(url)
    }
  }

  /**
   * Connect to a single WebSocket tracker
   */
  _connectTracker (url) {
    if (this._destroyed) return

    let ws
    try {
      ws = new WebSocket(url)
    } catch {
      return // Skip invalid URLs
    }

    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      this._sockets.set(url, ws)
      this._announce(ws)

      // Re-announce periodically
      const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          this._announce(ws)
        }
      }, this.announceInterval)
      if (timer.unref) timer.unref()
      this._announceTimers.push(timer)
    }

    ws.onmessage = async (event) => {
      try {
        const data = typeof event.data === 'string'
          ? JSON.parse(event.data)
          : JSON.parse(new TextDecoder().decode(event.data))
        await this._onTrackerMessage(ws, data)
      } catch {
        // Ignore unparseable messages
      }
    }

    ws.onclose = () => {
      this._sockets.delete(url)
      // Reconnect after delay
      if (!this._destroyed) {
        setTimeout(() => this._connectTracker(url), 5000 + Math.random() * 5000)
      }
    }

    ws.onerror = () => {
      // onclose will fire after this
    }
  }

  /**
   * Send an announce with SDP offers to the tracker
   */
  async _announce (ws) {
    if (ws.readyState !== WebSocket.OPEN) return

    const offers = []
    for (let i = 0; i < this.numOffers; i++) {
      try {
        const { offerId, sdpOffer } = await this._createOffer()
        offers.push({ offer_id: offerId, offer: sdpOffer })
      } catch {
        // Skip failed offers
      }
    }

    const msg = {
      action: 'announce',
      info_hash: toHex(this._bootstrapHash),
      peer_id: toHex(this.nodeId),
      numwant: this.numOffers,
      event: 'started',
      offers
    }

    ws.send(JSON.stringify(msg))
  }

  /**
   * Handle a message from the tracker
   */
  async _onTrackerMessage (ws, data) {
    if (data.action === 'announce') {
      if (data.offer) {
        // Incoming offer from another peer — create an answer
        const remotePeerId = data.peer_id
        if (remotePeerId === toHex(this.nodeId)) return // Ignore self

        try {
          const { sdpAnswer, nodeId } = await this._createAnswer(data.offer, remotePeerId)

          // Send the answer back through the tracker
          const answer = {
            action: 'announce',
            info_hash: toHex(this._bootstrapHash),
            peer_id: toHex(this.nodeId),
            to_peer_id: remotePeerId,
            offer_id: data.offer_id,
            answer: sdpAnswer
          }
          ws.send(JSON.stringify(answer))

          this.emit('peer', { nodeId, type: 'incoming' })
        } catch {
          // Failed to create answer
        }
      }

      if (data.answer) {
        // Answer to one of our offers
        this.emit('answer', {
          offerId: data.offer_id,
          sdpAnswer: data.answer,
          remotePeerId: data.peer_id
        })
      }
    }
  }

  /**
   * Stop the signaling client
   */
  destroy () {
    this._destroyed = true
    for (const timer of this._announceTimers) {
      clearInterval(timer)
    }
    this._announceTimers = []
    for (const ws of this._sockets.values()) {
      ws.close()
    }
    this._sockets.clear()
    this._pendingOffers.clear()
  }
}

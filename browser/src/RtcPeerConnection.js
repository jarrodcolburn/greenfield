'use strict'

import RtcPeerConnectionRequests from './protocol/RtcPeerConnectionRequests'
import GrBlobTransferResource from './protocol/GrBlobTransferResource'

import RtcBlobTransfer from './RtcBlobTransfer'

/**
 * @interface {RtcPeerConnectionRequests}
 */
export default class RtcPeerConnection extends RtcPeerConnectionRequests {
  /**
   * @param {!RtcPeerConnectionResource}rtcPeerConnectionResource
   * @returns {!RtcPeerConnection}
   */
  static create (rtcPeerConnectionResource) {
    const rtcPeerConnection = new RtcPeerConnection(rtcPeerConnectionResource)
    rtcPeerConnectionResource.implementation = rtcPeerConnection
    return rtcPeerConnection
  }

  /**
   * Use RtcPeerConnection.create(..)
   * @param {!RtcPeerConnectionResource}rtcPeerConnectionResource
   * @private
   */
  constructor (rtcPeerConnectionResource) {
    super()
    /**
     * @type {!RtcPeerConnectionResource}
     * @const
     */
    this.rtcPeerConnectionResource = rtcPeerConnectionResource
    /**
     * @type {?{_peerConnection:window.RTCPeerConnection, clientIceCandidates:function, clientSdpReply:function, clientSdpOffer: function}}
     * @private
     */
    this._delegate = null
    /**
     * @type {?function}
     * @private
     */
    this._peerConnectionResolve = null
    /**
     * @type {!Promise}
     * @private
     */
    this._peerConnectionPromise = new Promise((resolve) => {
      this._peerConnectionResolve = resolve
    })
  }

  /**
   *
   * @param {!RtcPeerConnectionResource} resource
   * @param {!number} id Returns new blob transfer object who's data will be send over the given rtc peer connection
   * @param {!string} descriptor blob transfer descriptor
   *
   * @since 1
   *
   */
  createBlobTransfer (resource, id, descriptor) {
    // TODO check if the descriptor label matches one we send out earlier and notify whoever created that descriptor
    // that there is now a blob transfer object available
    const blobTransferResource = new GrBlobTransferResource(resource.client, id, resource.version)
    RtcBlobTransfer._create(blobTransferResource, descriptor, this)
  }

  /**
   * @return {!Promise<RTCPeerConnection>}
   */
  onPeerConnection () {
    return this._peerConnectionPromise
  }

  /**
   * Setup the peer connection for client (local) to server (browser) communication.
   */
  async ensureP2S () {
    if (this._delegate && this._delegate._peerConnection) {
      // already initialized as p2s, return early.
      return
    } else if (this._delegate && !this._delegate._peerConnection) {
      // TODO we probably want to report this error to the client.
      throw new Error('Rtc peer connection already initialized in P2P mode.')
    }

    this._delegate = {
      _peerConnection: new window.RTCPeerConnection(
        {
          'iceServers': [
            {
              'urls': 'turn:badger.pfoe.be?transport=tcp',
              'username': 'greenfield',
              'credential': 'water'
            },
            {
              'urls': 'stun:stun.l.google.com:19302'
            }
          ]
        }
      ),

      clientIceCandidates: async (resource, description) => {
        try {
          const signal = JSON.parse(description)
          DEBUG && console.log(`webrtc received remote ice candidate`)
          await this._delegate._peerConnection.addIceCandidate(new window.RTCIceCandidate(signal.candidate))
        } catch (error) {
          console.error(error, error.stack)
        }
      },

      clientSdpReply: async (resource, description) => {
        try {
          const signal = JSON.parse(description)
          DEBUG && console.log(`webrtc received remote sdp answer`)
          await this._delegate._peerConnection.setRemoteDescription(new window.RTCSessionDescription(signal.sdp))
        } catch (error) {
          console.error(error, error.stack)
        }
      },

      clientSdpOffer: async (resource, description) => {
        try {
          const signal = JSON.parse(description)
          DEBUG && console.log(`webrtc received remote sdp offer`)
          await this._delegate._peerConnection.setRemoteDescription(new window.RTCSessionDescription(signal.sdp))
          const desc = await this._delegate._peerConnection.createAnswer()
          await this._delegate._peerConnection.setLocalDescription(desc)
          DEBUG && console.log(`Child ${process.pid} webrtc sending local sdp answer`)
          await this.rtcPeerConnectionResource.serverSdpReply(JSON.stringify({'sdp': this._delegate._peerConnection.localDescription}))
        } catch (error) {
          console.error(error, error.stack)
        }
      }
    }

    DEBUG && console.log(`webrtc created new peer connection with connection state: ${this._delegate._peerConnection.connectionState}`)
    this._delegate._peerConnection.onconnectionstatechange = () => {
      DEBUG && console.log(`webrtc peer connection connection state changed to: ${this._delegate._peerConnection.connectionState}`)
    }

    this._delegate._peerConnection.onicecandidate = (evt) => {
      if (evt.candidate !== null) {
        DEBUG && console.log(`webrtc sending local ice candide`)
        this.rtcPeerConnectionResource.serverIceCandidates(JSON.stringify({'candidate': evt.candidate}))
      }
    }
    this._delegate._peerConnection.onnegotiationneeded = () => {
      DEBUG && console.log(`webrtc negotiation needed`)
      this._sendOffer()
    }

    this._peerConnectionResolve(this._delegate._peerConnection)
  }

  /**
   * @return {Promise<void>}
   * @private
   */
  async _sendOffer () {
    try {
      const desc = await this._delegate._peerConnection.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
        voiceActivityDetection: false,
        iceRestart: false
      })
      await this._delegate._peerConnection.setLocalDescription(desc)
      DEBUG && console.log(`webrtc sending local sdp offer`)
      this.rtcPeerConnectionResource.serverSdpOffer(JSON.stringify({'sdp': this._delegate._peerConnection.localDescription}))
    } catch (error) {
      console.error(error, error.stack)
    }
  }

  /**
   * Setup the peer connection for client (local) to client (local) communication.
   * @param otherRtcPeerConnectionResource
   */
  ensureP2P (otherRtcPeerConnectionResource) {
    if (this._delegate && this._delegate._peerConnection) {
      // TODO we probably want to report this error to the client.
      throw new Error('Rtc peer connection already initialized in P2S mode.')
    } else if (this._delegate && this._delegate.otherRtcPeerConnectionResource !== otherRtcPeerConnectionResource) {
      // TODO we probably want to report this error to the client.
      throw new Error('Rtc peer connection already initialized with another peer.')
    } else if (this._delegate && this._delegate.otherRtcPeerConnectionResource === otherRtcPeerConnectionResource) {
      return
    }

    // TODO keep track in which mode the connection is initialized
    this._delegate = {
      otherRtcPeerConnectionResource: otherRtcPeerConnectionResource,
      clientIceCandidates: (resource, description) => {
        this._delegate.otherRtcPeerConnectionResource.serverIceCandidates(description)
      },

      clientSdpReply: (resource, description) => {
        this._delegate.otherRtcPeerConnectionResource.serverSdpReply(description)
      },

      clientSdpOffer: (resource, description) => {
        this._delegate.otherRtcPeerConnectionResource.serverSdpOffer(description)
      }
    }

    this.rtcPeerConnectionResource.init()
    // in the p2p case, we will never have a peer connection as it is the client peer connections that will be linked
  }

  /**
   * @param {!RtcPeerConnectionResource} resource
   * @param {!string}description
   */
  clientIceCandidates (resource, description) {
    this._delegate.clientIceCandidates(resource, description)
  }

  /**
   * @param {!RtcPeerConnectionResource} resource
   * @param {!string}description
   */
  clientSdpReply (resource, description) {
    this._delegate.clientSdpReply(resource, description)
  }

  /**
   * @param {!RtcPeerConnectionResource} resource
   * @param {!string}description
   */
  clientSdpOffer (resource, description) {
    this._delegate.clientSdpOffer(resource, description)
  }
}
// Copyright 2019 Erik De Rijcke
//
// This file is part of Greenfield.
//
// Greenfield is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Greenfield is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Greenfield.  If not, see <https://www.gnu.org/licenses/>.

import './style.css'
import ReactDOM from 'react-dom'
import React from 'react'
import PropTypes from 'prop-types'

import CssBaseline from '@material-ui/core/es/CssBaseline'

import TopPanel from './TopPanel'
import Workspace from './Workspace'
import ManagedSurface from './ManagedSurface'
import Snackbar from '@material-ui/core/es/Snackbar'
import NotificationContent from './NotificationContent'
import { createMuiTheme, MuiThemeProvider } from '@material-ui/core/es/styles'
import themeConfig from './theme.json'
import { RemoteAppLauncher, RemoteSocket, UserShellApi, WebAppLauncher, WebAppSocket } from 'compositor-module'

const theme = createMuiTheme(themeConfig)

// TODO we probably want a more mvvm like structure here
class DesktopUserShell extends React.Component {
  /**
   * @param {Seat}seat
   * @param {Session}session
   */
  static create (seat, session) {
    // WebAppSocket enables browser local applications running in a web worker to connect
    const webAppSocket = WebAppSocket.create(session)
    const webAppLauncher = WebAppLauncher.create(webAppSocket)

    // RemoteSocket enables native application-endpoints with remote application to connect
    const remoteSocket = RemoteSocket.create(session)
    const remoteAppLauncher = RemoteAppLauncher.create(session, remoteSocket)

    document.oncontextmenu = () => false
    const shellContainer = document.getElementById('shell-container')

    ReactDOM.render(
      <DesktopUserShell
        seat={seat}
        webAppLauncher={webAppLauncher}
        remoteAppLauncher={remoteAppLauncher}
      />,
      shellContainer
    )
  }

  /**
   * @param {{seat:Seat}}props
   */
  constructor (props) {
    super(props)
    /**
     * @type {{managedSurface: Array<ManagedSurface>, activeManagedSurface: ?ManagedSurface, notifications: Array<{variant: 'success'|'warning'|'error'|'info', message: string}>}}
     */
    this.state = {
      managedSurfaces: [],
      activeManagedSurface: null,
      notifications: []
    }

    UserShellApi.manage = (surface, userSurfaceState) => this._manage(surface)
    UserShellApi.notify = (variant, message) => this._notify(variant, message)
    UserShellApi.updateUserSurfaceState = (surface, userSurfaceState) => this.state.managedSurfaces.find(managedSurface => managedSurface.surface === surface).updateUserSurfaceState(userSurfaceState)

    window.onerror = (msg, url, line, col, error) => {
      let extra = !col ? '' : '\ncolumn: ' + col
      extra += !error ? '' : '\nerror: ' + error
      console.error(msg + '\nurl: ' + url + '\nline: ' + line + extra)
      UserShellApi.notify('error', error.message)
      // TODO: Report this error in a backend error log
      return true
    }

    this._activateManagedSurfaceOnPointerButton()
  }

  /**
   * Notify the user of an important event.
   *
   * @param {'success'|'warning'|'error'|'info'}variant
   * @param {string}message
   * @private
   */
  _notify (variant, message) {
    this.setState(prevState => {
      const absent = prevState.notifications.find(notification => notification.variant === variant && notification.message === message) == null
      if (absent) {
        return { notifications: [...prevState.notifications, { variant, message }] }
      } else {
        return prevState
      }
    })
  }

  /**
   * @param {string}reason
   * @param {{variant: 'success'|'warning'|'error'|'info', message: string}}closedNotification
   * @private
   */
  _closeNotification (reason, closedNotification) {
    if (reason === 'clickaway') {
      return
    }

    this.setState(prevState => ({
      notifications: prevState.notifications.filter(notification =>
        notification.variant !== closedNotification.variant &&
        notification.message !== closedNotification.message)
    }))
  }

  componentDidCatch (error, info) {
    UserShellApi.notify('error', 'Error: ' + error)
  }

  /**
   * Ask the user shell to start managing the given surface.
   * @param {Surface}surface
   * @param {function}activeCallback  Registers a callback that will be fired when the user shell wants to make a surface active (ie give it input)
   * @param {function}inactivateCallback Registers callback that notifies if a surface is no longer active (ie no longer receives input)
   * @return {UserShellSurface}
   * @private
   */
  _manage (surface) {
    const { seat } = /** @type{{seat:Seat}} */this.props

    // create new managed surface
    const managedSurface = new ManagedSurface(surface)
    managedSurface.onActivationRequest = () => { UserShellApi.actions.requestActivate(surface) }
    managedSurface.onInactive = () => { UserShellApi.actions.notifyInactive(surface) }

    // listen for client keyboard resource creation and store it in the managed surface
    const keyboardResourceListener = (wlKeyboardResource) => {
      if (surface.resource.client === wlKeyboardResource.client) {
        managedSurface.wlKeyboardResource = wlKeyboardResource
        wlKeyboardResource.onDestroy().then(() => { managedSurface.wlKeyboardResource = null })

        const { activeManagedSurface } = /** @type{{activeManagedSurface: ManagedSurface|null}} */ this.state
        // if managed surface is active, give it keyboard focus
        if (activeManagedSurface === managedSurface) {
          managedSurface.giveKeyboardFocus()
        }
      }
    }
    seat.addKeyboardResourceListener(keyboardResourceListener)
    seat.keyboard.resources.forEach(keyboardResourceListener)

    // add the managed surface to state
    this._addManagedSurface(managedSurface)

    // remove managed surface from state if the underlying surface is destroyed
    surface.resource.onDestroy().then(() => {
      this._removeManagedSurface(managedSurface)
      seat.removeKeyboardResourceListener(keyboardResourceListener)
    })

    // register an activation listener and set active managed surface state if it received an activation event
    managedSurface.onActivation.push(() => this.setState(({ activeManagedSurface: previousActiveManagedSurface }) => {
      if (previousActiveManagedSurface !== managedSurface) {
        if (previousActiveManagedSurface && previousActiveManagedSurface.deactivate) {
          previousActiveManagedSurface.deactivate()
        }
        managedSurface.giveKeyboardFocus()
      }
      return { activeManagedSurface: managedSurface }
    }))
  }

  /**
   * Makes a surface active if a user clicks on it.
   * @private
   */
  _activateManagedSurfaceOnPointerButton () {
    const { seat } = /** @type {{seat: Seat}} */this.props

    seat.pointer.onButtonPress().then(() => {
      if (seat.pointer.focus) {
        const { managedSurfaces, activeManagedSurface } =
          /** @type {{managedSurface: Array<ManagedSurface>, activeManagedSurface: ManagedSurface|null}} */this.state
        const targetManagedSurface = managedSurfaces.find(managedSurface => {
          return !managedSurface.view.destroyed &&
            seat.pointer.focus.surface === managedSurface.surface &&
            managedSurface !== activeManagedSurface &&
            managedSurface.requestActivation
        })

        if (targetManagedSurface) {
          targetManagedSurface.requestActivation(targetManagedSurface)
        }
      }
      setTimeout(() => this._activateManagedSurfaceOnPointerButton())
    })
  }

  /**
   * @param {ManagedSurface}managedSurface
   * @private
   */
  _addManagedSurface (managedSurface) {
    this.setState(
      /**
       * @param {Array<ManagedSurface>}managedSurfaces
       * @return {{managedSurfaces: Array<ManagedSurface>}}
       */
      ({ managedSurfaces }) => {
        return {
          managedSurfaces: [...managedSurfaces, managedSurface]
        }
      })
  }

  /**
   * @param {ManagedSurface}managedSurface
   * @private
   */
  _removeManagedSurface (managedSurface) {
    this.setState(
      /**
       * @param {Array<ManagedSurface>}managedSurfaces
       * @param {ManagedSurface}activeManagedSurface
       * @return {{managedSurfaces: Array<ManagedSurface>}}
       */
      ({ managedSurfaces, activeManagedSurface }) => {
        return {
          activeManagedSurface: activeManagedSurface === managedSurface ? null : activeManagedSurface,
          managedSurfaces: managedSurfaces.filter(element => element.surface !== managedSurface.surface)
        }
      })
  }

  render () {
    const { seat, webAppLauncher, remoteAppLauncher } =
      /** @
       * type{{seat:Seat, webAppLauncher:WebAppLauncher, remoteAppLauncher:RemoteAppLauncher}}
       * */
      this.props
    const { managedSurfaces, activeManagedSurface, notifications } =
      /**
       * @type {{managedSurface: Array<ManagedSurface>, activeManagedSurface: ?ManagedSurface, notifications: Array<{variant: 'success'|'warning'|'error'|'info', message: string}>}}
       * */
      this.state
    return (
      <React.Fragment>
        <CssBaseline />
        <MuiThemeProvider theme={theme}>
          <TopPanel
            managedSurfaces={managedSurfaces}
            activeManagedSurface={activeManagedSurface}
            seat={seat}
            webAppLauncher={webAppLauncher}
            remoteAppLauncher={remoteAppLauncher}
          />
          {
            notifications.map(notification =>
              <Snackbar
                key={notification.variant + notification.message}
                open
                anchorOrigin={{
                  vertical: 'bottom',
                  horizontal: 'left'
                }}
                autoHideDuration={6000}
                onClose={(event, reason) => this._closeNotification(reason, notification)}
              >
                <NotificationContent
                  onClose={(event, reason) => this._closeNotification(reason, notification)}
                  variant={notification.variant}
                  message={notification.message}
                />
              </Snackbar>
            )
          }
          <Workspace
            managedSurfaces={managedSurfaces}
            activeManagedSurface={activeManagedSurface}
            seat={seat}
          />
        </MuiThemeProvider>
      </React.Fragment>
    )
  }
}

DesktopUserShell.propTypes = {
  seat: PropTypes.object.isRequired,
  webAppLauncher: PropTypes.instanceOf(WebAppLauncher).isRequired,
  remoteAppLauncher: PropTypes.instanceOf(RemoteAppLauncher).isRequired
}

export default DesktopUserShell

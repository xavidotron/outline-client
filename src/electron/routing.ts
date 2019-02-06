// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {createConnection, Socket} from 'net';
import {platform} from 'os';

import * as errors from '../www/model/errors';

interface RoutingServiceRequest {
  action: string;
  parameters: {[parameter: string]: string|boolean};
}

interface RoutingServiceResponse {
  action: RoutingServiceAction;  // Matches RoutingServiceRequest.action
  statusCode: RoutingServiceStatusCode;
  errorMessage?: string;
  connectionStatus: ConnectionStatus;
}

enum RoutingServiceAction {
  CONFIGURE_ROUTING = 'configureRouting',
  RESET_ROUTING = 'resetRouting',
  STATUS_CHANGED = 'statusChanged'
}

enum RoutingServiceStatusCode {
  SUCCESS = 0,
  GENERIC_FAILURE = 1,
  UNSUPPORTED_ROUTING_TABLE = 2
}

const SERVICE_ADDRESS =
    platform() === 'win32' ? '\\\\.\\pipe\\OutlineServicePipe' : '/var/run/outline_controller';

// Communicates with the Outline routing daemon via a Unix socket.
//
// Works on both Windows and Linux.
//
// Due to the complexity of emulating a Promise-like interface (currently expected by the rest of
// the system) on top of a pipe-like connection to the service, *multiple, concurrent calls to
// start() or stop() are not recommended*. For this reason - and because on Windows multiple clients
// cannot connect to the pipe concurrently - this class connects to the service for *as short a time
// as possible*: CONFIGURE_ROUTING always uses a *new* connection to the service and the socket is
// always closed after receiving a RESET_ROUTING response.
//
// Run these commands to start/stop the service:
//  - Linux:
//    sudo systemctl start outline_proxy_controller.service
//    sudo systemctl stop outline_proxy_controller.service
//  - Windows:
//    net stop OutlineService
//    net start OutlineService
//
// TODO: network change notifications
export class RoutingService {
  private socket?: Socket;

  private disconnectionListener?: () => void;

  private fulfillStart?: () => void;
  private rejectStart?: (e: Error) => void;
  private fulfillStop?: () => void;

  // TODO: sets a member and returns that member for type-safety convenience - ugly?
  // TODO: offer to install the service
  private async getSocket(): Promise<Socket> {
    if (this.socket) {
      return this.socket;
    }

    return new Promise<Socket>((F, R) => {
      const newSocket = createConnection(SERVICE_ADDRESS, () => {
        console.log('connected to routing service');

        newSocket.on('data', (data) => {
          // This is very useful for debugging and *does not contain any PII*.
          console.log(`received message from routing service: ${data.toString().trim()}`);
          const responseFromService: RoutingServiceResponse = JSON.parse(data.toString());
          switch (responseFromService.action) {
            case RoutingServiceAction.CONFIGURE_ROUTING:
              if (!(this.fulfillStart && this.rejectStart)) {
                console.error('unexpected CONFIGURE_ROUTING response');
                newSocket.end();
                return;
              }

              if (responseFromService.statusCode === RoutingServiceStatusCode.SUCCESS) {
                this.fulfillStart();
              } else {
                this.rejectStart(
                    responseFromService.statusCode ===
                            RoutingServiceStatusCode.UNSUPPORTED_ROUTING_TABLE ?
                        new errors.UnsupportedRoutingTable(responseFromService.errorMessage) :
                        new errors.ConfigureSystemProxyFailure(responseFromService.errorMessage));
                newSocket.end();
              }
              break;
            case RoutingServiceAction.RESET_ROUTING:
              // TODO: handle failures
              if (this.fulfillStop) {
                this.fulfillStop();
              }
              newSocket.end();
              break;
            default:
              console.error(`unexpected response type received from routing service`);
          }
        });

        // Invoked as a result of calling end() *and* service/socket failure.
        newSocket.once('close', () => {
          console.log('disconnected from routing service');
          newSocket.removeAllListeners();
          this.socket = undefined;
          if (this.disconnectionListener) {
            this.disconnectionListener();
          }
        });

        this.socket = newSocket;
        F(newSocket);
      });

      // This is sufficient to detect a failure to connect initially; subsequent disconnections are
      // handled by the close handler, above.
      newSocket.once('error', (e) => {
        R(new errors.SystemConfigurationException());
      });
    });
  }

  setDisconnectionListener(newListener?: () => void): void {
    this.disconnectionListener = newListener;
  }

  // TODO: autoconnect
  // TODO: remove routerIp param from the Windows service (it's baked into it on Linux)
  async start(proxyAddress: string) {
    // TODO: is this necessary and is there a better way?
    if (this.socket) {
      throw new Error('already connected, please call stop first');
    }

    const socket = await this.getSocket();
    socket.write(JSON.stringify({
      action: RoutingServiceAction.CONFIGURE_ROUTING,
      parameters: {'proxyIp': proxyAddress, 'routerIp': '10.0.85.1', 'isAutoConnect': false}
    }));
    return new Promise<void>((F, R) => {
      this.fulfillStart = F;
      this.rejectStart = R;
    });
  }

  async stop() {
    const socket = await this.getSocket();
    socket.write(JSON.stringify({action: RoutingServiceAction.RESET_ROUTING, parameters: {}}));
    return new Promise<void>((F) => {
      this.fulfillStop = F;
    });
  }
}

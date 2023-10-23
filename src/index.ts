import { grpc } from "@improbable-eng/grpc-web";
import { NodeHttpTransport } from "@improbable-eng/grpc-web-node-http-transport";
import { BadgeGenerator } from "@lavanet/lava-sdk/bin/src/grpc_web_services/lavanet/lava/pairing/badges_pb_service.js";
import { GenerateBadgeResponse } from "@lavanet/lava-sdk/bin/src/grpc_web_services/lavanet/lava/pairing/badges_pb.js";
import { PluginAPI } from "@lumeweb/interface-relay";
import Metadata = grpc.Metadata;
import client = grpc.client;

interface BadgeRequest {
  data: Uint8Array;
}

const transport = NodeHttpTransport();

async function timeoutPromise<T>(timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error("Timeout exceeded"));
    }, timeout);
  });
}

async function relayWithTimeout<T>(
  timeLimit: number,
  task: Promise<T>,
): Promise<T | Error> {
  return await Promise.race([task, timeoutPromise<Error>(timeLimit)]);
}

function unframeRequest(frame: Uint8Array): Uint8Array | null {
  if (frame.length < 5) {
    console.error("Frame is too short to contain a valid message.");
    return null;
  }

  const messageLength = new DataView(
    frame.buffer,
    frame.byteOffset + 1,
    4,
  ).getUint32(0, false /* big endian */);

  if (frame.length !== messageLength + 5) {
    console.error("Frame length doesn't match the expected message length.");
    return null;
  }

  return frame.subarray(5);
}

const HEADER_SIZE = 5;

function frameRequest(data: Uint8Array, type = 0x0): Uint8Array {
  // Serialize the request if needed.
  // Create the frame with the necessary length.
  const frame = new Uint8Array(data.byteLength + HEADER_SIZE);

  // Use DataView to set the length of the payload.
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(1, data.length, false /* big endian */);

  // Set the type in the MSB of the first byte.
  frame[0] = type;

  // Copy the bytes of the data into the frame.
  frame.set(data, HEADER_SIZE);

  return frame;
}

export function serializeBrowserHeaders(headers: Metadata): string {
  let result = "";
  headers.forEach((key, values) => {
    values.forEach((value) => {
      result += `${key}: ${value}\r\n`;
    });
  });
  return result;
}

export function encodeASCII(input: string): Uint8Array {
  const encoded = new Uint8Array(input.length);
  for (let i = 0; i !== input.length; ++i) {
    const charCode = input.charCodeAt(i);
    if (!isValidHeaderAscii(charCode)) {
      throw new Error("Metadata contains invalid ASCII");
    }
    encoded[i] = charCode;
  }
  return encoded;
}

const isAllowedControlChars = (char: number) =>
  char === 0x9 || char === 0xa || char === 0xd;

function isValidHeaderAscii(val: number): boolean {
  return isAllowedControlChars(val) || (val >= 0x20 && val <= 0x7e);
}

function invoke(methodDescriptor: any, props: any) {
  const grpcClient = client(methodDescriptor, {
    host: props.host,
    transport: props.transport,
    debug: props.debug,
  });

  if (props.onHeaders) {
    grpcClient.onHeaders(props.onHeaders);
  }
  if (props.onMessage) {
    grpcClient.onMessage(props.onMessage);
  }
  if (props.onEnd) {
    grpcClient.onEnd(props.onEnd);
  }

  grpcClient.start(props.metadata);
  grpcClient.send(props.request);
  grpcClient.finishSend();

  return {
    client: grpcClient,
    close: () => {
      grpcClient.close();
    },
  };
}

const SERVER = "http://relay1.lumeweb.com:8082";
const PROJECT_ID = "f195d68175eb091ec1f71d00f8952b85";
const plugin = {
  name: "lavanet",
  async plugin(api: PluginAPI) {
    api.registerMethod("badge_request", {
      cacheable: false,
      async handler(req: BadgeRequest) {
        req.data = new Uint8Array(Object.values(req.data));
        req.data = unframeRequest(req.data) as any;
        if (!req.data) {
          throw new Error("invalid data");
        }
        const requestPromise = new Promise<Uint8Array[]>((resolve, reject) => {
          const request =
            BadgeGenerator.GenerateBadge.requestType.deserializeBinary(
              req.data,
            );
          request.setProjectId(PROJECT_ID);

          let responses: Uint8Array[] = [];
          let grpcHeaders: Metadata[] = [];

          const grpcReq = invoke(BadgeGenerator.GenerateBadge, {
            request,
            host: SERVER,
            transport: transport,
            onHeaders(headers: Metadata) {
              responses.push(
                frameRequest(
                  encodeASCII(serializeBrowserHeaders(headers)),
                  0x80,
                ),
              );

              if (!headers.has("grpc-status")) {
                // @ts-ignore
                grpcReq.client.responseHeaders = undefined;
                grpcHeaders.push(headers);
              } else {
                // @ts-ignore
                grpcReq.client.responseTrailers = headers;

                const newHeaders = new Metadata();

                grpcHeaders.forEach((metadata) => {
                  metadata.forEach((key, values: string[]) => {
                    newHeaders.append(key, values);
                  });
                });

                // @ts-ignore
                grpcReq.client.responseHeaders = newHeaders;
              }
            },
            onMessage(message: GenerateBadgeResponse) {
              responses.push(frameRequest(message.serializeBinary()));
            },
            onEnd(code, msg) {
              if (code === grpc.Code.OK || msg === undefined) {
                resolve(responses);
                return;
              }
              reject(
                new Error(
                  "Failed fetching a badge from the badge server, message: " +
                    msg,
                ),
              );
            },
          });
        });
        const ret = await relayWithTimeout<Uint8Array[]>(5000, requestPromise);
        if (ret instanceof Error) {
          return ret;
        }

        return ret.map((item) => Array.from(item));
      },
    });
  },
};

export default plugin;

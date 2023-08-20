import { grpc } from "@improbable-eng/grpc-web";
import { NodeHttpTransport } from "@improbable-eng/grpc-web-node-http-transport";
import { BadgeGenerator } from "@lavanet/lava-sdk/bin/src/grpc_web_services/lavanet/lava/pairing/badges_pb_service.js";
import { GenerateBadgeResponse } from "@lavanet/lava-sdk/bin/src/grpc_web_services/lavanet/lava/pairing/badges_pb.js";
import { PluginAPI } from "@lumeweb/interface-relay";
import ProtobufMessage = grpc.ProtobufMessage;

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

function frameRequest(request: ProtobufMessage): Uint8Array {
  const bytes = request.serializeBinary();
  const frame = new ArrayBuffer(bytes.byteLength + 5);
  new DataView(frame, 1, 4).setUint32(0, bytes.length, false /* big endian */);
  new Uint8Array(frame, 5).set(bytes);
  return new Uint8Array(frame);
}

const SERVER = "http://alpha.web3portal.com:8081";
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
        const requestPromise = new Promise<Uint8Array>((resolve, reject) => {
          const request =
            BadgeGenerator.GenerateBadge.requestType.deserializeBinary(
              req.data,
            );
          request.setProjectId(PROJECT_ID);
          grpc.invoke(BadgeGenerator.GenerateBadge, {
            request,
            host: SERVER,
            transport: transport,
            onMessage(message: GenerateBadgeResponse) {
              resolve(frameRequest(message));
            },
            onEnd(code, msg) {
              if (code === grpc.Code.OK || msg === undefined) {
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
        return relayWithTimeout<Uint8Array>(5000, requestPromise);
      },
    });
  },
};

export default plugin;

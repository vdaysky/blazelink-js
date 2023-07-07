import {
    dependencyMap, isDependencyAffected,
    objectIdToPrimitive,
    ObjID,
    primitiveObjectIdToString
} from "./models.js";



export type StateUpdateMessage = {
    update_type: string,
    identifier: ObjID,
    changes: {[key: string]: any} | null,
};

export class SocketConnection {

    connected: boolean
    queue: any[]
    sock?: WebSocket
    sock_delay: number = 1
    sessionId: string

    constructor(sessionId: string) {
        this.connected = false;
        this.queue = [];
        this.sessionId = sessionId;
        this.try_connect();
    }

    async confirm(msgId: number) {
        const message = {
            type: 'ConfirmEvent',
            data: {
                confirm_message_id: msgId,
                payload: {},
            }
        }
        this.sock?.send(JSON.stringify(message));
    }

    async onWsMessage(event: MessageEvent) {

        const data: {type: string, data: {[key: string]: any}, msg_id: number} = JSON.parse(event.data);

        if (data.type == 'ModelUpdateEvent') {
            const payload: StateUpdateMessage = data.data as StateUpdateMessage;
            const idStr = primitiveObjectIdToString(objectIdToPrimitive(payload.identifier));

            console.log("Updated ID", idStr, "Type", payload.update_type, "Changes", payload.changes);

            // find all objects that depend on updated key.
            // we need to keep in mind that there may not be exact matches.
            // models that depend on entire table need to be updated when any row is updated.

            let dependencies = dependencyMap[idStr] || [];

            if (payload.identifier.obj_id != null) {
                const idStrNoObj = primitiveObjectIdToString({
                    entity: payload.identifier.entity,
                    obj_id: null,
                });
                // update for any row should also trigger update for entire table
                dependencies = dependencies.concat(dependencyMap[idStrNoObj] || []);
            }

            dependencies.forEach(([dep, model]) => {
                // only update model if there is no advanced dependency declared,
                // or if update matches declared dependency
                if (!dep || isDependencyAffected(dep, model, payload)) {
                    console.log("Model", model, "will de updated")
                    model.initiateRefresh();
                } else {
                    console.log("Model", model, "is not affected by update")
                }
            });

            await this.confirm(data.msg_id);
        }
    }

    onOpen() {
        if (!this.sock)
            return;

        const sock = this.sock as WebSocket;

        console.log("Socket opened");
        this.sock_delay = 1;
        this.connected = true;
        this.queue.forEach(packet => {
            sock.send(JSON.stringify(packet));
        });
        this.queue = [];
    }

    onClose() {
        console.log(`socket closed, trying to reconnect after ${this.sock_delay} seconds`);
        this.sock = undefined;

        const reconnectFunc = ()=>this.try_connect();

        setTimeout(
            reconnectFunc,
            this.sock_delay * 1000
        );

        this.sock_delay = Math.min(this.sock_delay + 5, 30);
    }

    try_connect() {

        this.sock = new WebSocket("ws://" + window.location.hostname + ":8000/ws/connect?session_id=" + this.sessionId);

        this.sock.onmessage = event => this.onWsMessage(event);
        this.sock.onopen = this.onOpen
        this.sock.onclose = () => this.onClose();
    }
}
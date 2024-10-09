import { Store } from './../../../store';
import { Console } from "console";
import { getLogger } from "../logIt-factory";
import { createCipheriv, Cipher, Decipher, createDecipheriv } from 'crypto';
import { Subject } from 'rxjs';
import { Info } from "../info";
var net = require('net');
var streamBuffers = require('stream-buffers');

const service_host = '127.0.0.1';
const servive_port = 51779;

export enum PacketID {
    NOTIFIACTION = 120,
    INITIALIZATION = 60,
    GET_MONITOR_DATA = 50,
    GET_UPDATED_DATA = 40,
    SET_DEVICE_DATA = 30
}

interface CallbackItem {
    funcName: string;
    resolve;
    reject;
}

export class PSSdkStreamReader {
    bracketsCount = 0;
    bufferedString: string = '';
    constructor(private callback: any) {
    }

    flushSegment(data: string, s: number, e: number) {
        if (this.bufferedString.length == 0 && s == e)  // empty
            return;
        var d = this.bufferedString + data.substring(s, e);
        this.callback(d);
        this.bufferedString = '';
    }

    putData(data: string) {
        var startPos = 0;
        for (var i = 0; i < data.length; i++) {
            if (data[i] == '{') {
                if (this.bracketsCount == 0) {
                    this.flushSegment(data, startPos, i);
                    startPos = i;
                }
                this.bracketsCount++;
            } else if (data[i] == '}') {
                this.bracketsCount--;
                if (this.bracketsCount == 0) {
                    if (data[i + 1] == '\n') {
                        i++;
                    }
                    this.flushSegment(data, startPos, i + 1);
                    startPos = i + 1;
                }
            }
        }
        if (startPos < data.length) {
            this.bufferedString += data.substring(startPos);
        }
    }
}

export class ades {

    private static _instance: ades;
    ServiceVer: any;

    static get instance(): ades {
        if (!ades._instance) ades._instance = new ades();
        return ades._instance;
    }

    socket;
    decipher: Decipher;
    connected = false;
    cipher: Cipher;
    callbackArray: CallbackItem[] = [];
    streamReader: PSSdkStreamReader;
    info = Info.getInstance();
    store = Store.getInstance();

    seq_send_idx = 0;
    seq_in_out = 0;
    gotData = new Subject();

    constructor() {
        this.connectToService();
    }

    private reConnectToService() {
        getLogger().info(`[ADES] Reconnect To Service`);
        console.log(`[ADES] Reconnect To Service`);
        setTimeout(() => {
            if (!this.connected) {
                this.connectToService();
            }
        }, 2000000)
    }

    delay = time => new Promise(res => setTimeout(res, time));

    private connectToService() {
        const host = service_host;
        const port = servive_port;
        this.socket = net.createConnection({ host, port }, () => {
            getLogger().info(`[ADES] connectToService`);
            console.log(`[ADES] connectToService`);
            this.connected = true;
        });

        this.socket.on('connect',async () => {
            getLogger().info(`[ADES] success connect to ${host}:${port}`);
            console.log(`[ADES] success connect to ${host}:${port}!!`);
            if(await this.store.get('needShowPrivacyPolicy') == false){
                let IsAgreePrivacyPolicy:any = await this.info.getIsAgreePrivacyPolicy();
                getLogger().info(`[ADES] needShowPrivacyPolicy is false so to send IsAgreePrivacyPolicy`);
                getLogger().info(`[ADES] IsAgreePrivacyPolicy => ${IsAgreePrivacyPolicy}`);
                this.notificationdata(IsAgreePrivacyPolicy);
            }
        });

        this.socket.on('close', () => {
            getLogger().info(`[ADES] Close the connection`);
            console.log(`[ADES] Close the connection`);
            this.connected = false;
            this.reConnectToService();
        });

        this.socket.on('error', (err) => {
            getLogger().info('[ADES]  Error occur! Connection closed');
            getLogger().info(err);
            console.log('[ADES] ' + err);
        });

        this.socket.on('drain', () => {
            getLogger().info(`[ADES] Drain the data`);
            console.log(`[ADES] Drain the data`);
        });

        this.socket.on('data',async (buf) => {
            var data = buf.toString();
            if (this.decipher) {
                var v = Buffer.from(data, "base64");
                data = this.decipher.update(v, undefined, 'utf8');
                data += this.decipher.final('utf8');
            }
            this.streamReader.putData(data);
        });
        this.streamReader = new PSSdkStreamReader(async (data) => {
            getLogger().debug(`[ADES] '${data}'`);
            try {
                const rep = JSON.parse(data);
                getLogger().debug(`[ADES] rep = ${JSON.stringify(rep)}`);
                if (rep.request)
                    getLogger().info(`RCV ${rep.request}`);
                this.gotData.next(rep);
                if (rep.request) {
                    const idx = this.callbackArray.findIndex(callback => callback.funcName === rep.request);
                    if (idx !== -1) {
                        getLogger().info(`[ADES] Callback function for request: ${rep.request},idx:${idx}`);
                        //this.broadcastRes(rep);
                        this.callbackArray[idx].resolve(rep);
                        this.callbackArray.splice(idx, 1);
                    }
                    else
                        getLogger().info(`[ADES] Can not find any callback function for request: ${rep.request}`);
                }  
            } catch (ex) {
                getLogger().error(`${ex.name} - ${ex.message}`);
                console.error(ex);
            }
        });
    }

    sendRequest(packetId: PacketID, request) {
        const idx = this.seq_send_idx++;
        getLogger().debug(`sendRequest ${PacketID[packetId]}: ${JSON.stringify(request)}`);
        const p = new Promise(async (resolve, reject) => {

            var ws = new streamBuffers.WritableStreamBuffer();
            ws.write('XXX');  //標頭
            let buffer = Buffer.from(new Uint32Array([packetId]).buffer)
            ws.write(buffer);
            var cmd = JSON.stringify(request);
            ws.write(cmd);
            var v = ws.getContents();
            if (this.cipher) {
                v = this.cipher.update(v, 'binary', 'base64');
                v += this.cipher.final('base64');
                v = Buffer.from(v, 'base64');
            }
            this.socket.write(v);
            getLogger().info(`SND ${v}`);

            getLogger().info(`SND ${PacketID[packetId]} / ${request.Function || PacketID[packetId]}`);
            getLogger().debug(`${PacketID[packetId]}: ${cmd}`);

            var funcName = request.Function;

            this.callbackArray.push({
                funcName: request.Function || PacketID[packetId],
                resolve,
                reject
            });

        });
        return p;
    }

    async notificationdata(tf:boolean) {
        getLogger().info(`[ADES] notificationdata!!`);
        console.log(`[ADES] notificationdata!!`);
        if(tf){
            return this.sendRequest(PacketID.NOTIFIACTION, { "Function": "XXX", "Parameter": { "status": 1 } })
        }else{
            return this.sendRequest(PacketID.NOTIFIACTION, { "Function": "XXX", "Parameter": { "status": 0 } })
        }
    }

    async Initialization_ServiceVersion(){
        getLogger().debug(`[PA] getVersion`);
        return this.sendRequest(PacketID.INITIALIZATION,
            { Function: "VERSION" }).then((v: any) => {
                this.ServiceVer=v;
                getLogger().info(`[PA]INITIALIZATION Service version:${this.ServiceVer}`);
                return v;
            });
    }

    getServiceVersion() {
        getLogger().info(`[PA] Service version:${this.ServiceVer}`);
        return this.ServiceVer;
    }

    async getBatteryBoost() {
        getLogger().debug(`[PA] getBatteryBoost`);
        return this.sendRequest(PacketID.GET_UPDATED_DATA,
            { Function: "BATTERY_BOOST" }).then((v: any) => {
                return v;
            });
    }

    async setDeviceData(funName: string, v: any) {

        if (funName == "ScenarioChanged") {
            return null;
        }
        getLogger().info(`[PA] SET_DEVICE_DATA: ${funName},v:${JSON.stringify(v)}`);

        return this.sendRequest(PacketID.SET_DEVICE_DATA, {
            Function: funName,
            Parameter: v
        });
    }

    async setDataWithoutScenario(funName: string, v: any) {

        if (funName == "ScenarioChanged") {
            return null;
        }
        getLogger().info(`[PA] SET_DEVICE_DATA_2: ${funName},v:${JSON.stringify(v)}`);
        return this.sendRequest(PacketID.SET_DEVICE_DATA, {
            Function: funName,
            Parameter: v
        });
    }
}
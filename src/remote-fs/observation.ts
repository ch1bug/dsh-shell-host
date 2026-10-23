/** #139：远程专用观察状态；移植上游687f282e fs-observation-policy，不发本地fs事件。 */
import { FsError, type FsObservation, type FsTarget, type FsVersion, type FsWriteIntent } from "./contract.ts";
/** 每个remote-fs上下文持有一份；session弱引用，opaque targetKey不解析。 */
export class RemoteObservations {
    private observed = new WeakMap<object, Map<string, FsObservation>>();
    private owner(actor: object | undefined): object | undefined {
        return (actor as {
            agent?: {
                session?: object;
            };
        } | undefined)?.agent?.session;
    }
    private prior(target: FsTarget, actor: object | undefined): FsObservation | undefined {
        const owner = this.owner(actor);
        return owner ? this.observed.get(owner)?.get(target.targetKey) : undefined;
    }
    writeIntent(target: FsTarget, actor: object | undefined): FsWriteIntent {
        const prior = this.prior(target, actor);
        return prior?.kind === "present"
            ? { kind: "replaceIfVersion", version: prior.version }
            : { kind: "createIfAbsent" };
    }
    editIntent(target: FsTarget, actor: object | undefined): {
        version: FsVersion;
    } {
        const prior = this.prior(target, actor);
        if (prior === undefined)
            throw new FsError(`edit requires reading "${target.displayPath}" first`, "FS_NOT_OBSERVED");
        if (prior.kind === "absent")
            throw new FsError(`cannot edit "${target.displayPath}": not found`, "FS_NOT_FOUND");
        return { version: prior.version };
    }
    /** 权威读取/缺失或mutation成功后记录；不接stat/list事件。 */
    record(target: FsTarget, observation: FsObservation, actor: object | undefined): void {
        const owner = this.owner(actor);
        if (!owner)
            return;
        let byTarget = this.observed.get(owner);
        if (!byTarget) {
            byTarget = new Map();
            this.observed.set(owner, byTarget);
        }
        byTarget.set(target.targetKey, observation);
    }
    clear(): void { this.observed = new WeakMap(); }
}

import {StateUpdateMessage} from "./network";

type PrimitiveType = typeof Number | typeof String | typeof Boolean;
type Primitive = number | string | boolean;
type GraphQlType = PrimitiveType | typeof Loadable | string | typeof Model | typeof Struct;
type GraphQlValue = Primitive | Loadable | GraphQlValue[];

export const modelTypes: {[key: string]: typeof Loadable | typeof Model} = {}

/** Maps objectId to models that depend on it
 *
 * key is a string <entity>:<id>
 * */
export const dependencyMap: {
    [key: string]: [Dependency<any, any> | null, Loadable][]
} = {}

/** Maps arbitrary internal event to models that depend on it */
export const eventDependencyMap: {[key: string]: Loadable[]} = {}

export const sessionId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);


declare global {
    interface Window {
        registry: {[key: string]: Model},
        sessionID: string
        dependencyMap: {[key: string]: [Dependency<any, any> | null, Loadable][]}
        eventDependencyMap: {[key: string]: Loadable[]}
        modelTypes: {[key: string]: typeof Loadable | typeof Model}
        $models: ModelManager
    }
}

export function registerModelType(model: typeof Loadable | typeof Model) {
    modelTypes[model.name] = model;
}

window.dependencyMap = dependencyMap;
window.eventDependencyMap = eventDependencyMap;
window.modelTypes = modelTypes;

export function createDep<M extends typeof Model, T extends typeof Model>(
    self: M,
    entity: T,
    events: string[],
    where: Partial<{
        [K in keyof InstanceType<M>]: keyof InstanceType<T>
    }>,
    predicate?: (newVal: InstanceType<T>, changes: {[key: string]: any}, self: InstanceType<M>) => boolean
): Dependency<M, T> {
    return {
        entity,
        events,
        where,
        predicate
    };
}

class ArgTree {

    [key: string]: ArgTree | any

    constructor(value: any) {

        return new Proxy(value, {
            get: (target: { [key: string | symbol]: any }, name: string | symbol) => {
                if (name in target) {
                    return target[name];
                } else {
                    if (typeof name === "string" && name.startsWith("_")) {
                        return undefined;
                    }
                    if (typeof name === "symbol") {
                        return undefined;
                    }
                    if (["state", "getters", "vm", "toJSON"].includes(name)) {
                        return undefined;
                    }
                    return target[name] = new ArgTree({});
                }
            }
        })
    }
}

function argTreeToSignature(args: ArgTree) {
    const signature: {[key: string]: any} = {}

    for (const [key, value] of Object.entries(args)) {
        // we prefix arguments (leaf nodes) with $ to distinguish them from fields
        if (!key.startsWith("$")) {
            continue;
        }
        signature[key.slice(1)] = value;
    }
    return signature;
}


function stringifyWithoutKeyQuotes(data: Object): string {

    if (data == null) return 'null';

    if (Array.isArray(data)) {
        return `[${data.map(item => stringifyWithoutKeyQuotes(item)).join(", ")}]`;
    }

    // is dictionary
    if (typeof data === 'object') {
        let result = "{";
        for (const [key, value] of Object.entries(data)) {
            result += `${key}: ${stringifyWithoutKeyQuotes(value)},`;
        }
        // remove trailing comma
        if (result.length > 1) {
            result = result.slice(0, -1);
        }
        result += "}";
        return result;
    }
    return JSON.stringify(data);
}

// @deprecated
export function objectIdToString(objectId: ObjID) {

    const copy = JSON.parse(JSON.stringify(objectId));
    copy.entity = copy.entity.toLowerCase().replace("_", "");

    return JSON.stringify(copy, Object.keys(copy).sort());
}

export function primitiveObjectIdToString(objectId: PrimitiveObjectId) {

    const normalizedEntity = objectId.entity.toLowerCase().replace("_", "");

    return `${normalizedEntity}:${objectId.obj_id}`
}


class FieldInfo {

    _type: GraphQlType
    alias?: string
    list?: boolean

    constructor(data: {type?: GraphQlType, alias?: string, list?: boolean}) {
        this._type = data.type || (this as unknown as typeof Loadable);
        this.alias = data.alias;
        this.list = data.list;
    }

    getType(): GraphQlType {
        if (typeof this._type === 'string') {
            return modelTypes[this._type];
        }
        return this._type;
    }

    hasPrimitiveType() {
        return this.getType() === Number || this.getType() === String || this.getType() === Boolean;
    }

    isPrimitive() {
        return this.hasPrimitiveType() && !this.list;
    }

    isModel() {
        //@ts-ignore
        // is subclass of Model class
        return this.getType().prototype instanceof Model;
    }

    isStruct() {
        //@ts-ignore
        return this.getType().prototype instanceof Struct;
    }

    toGraphQL(fieldName: string, depth: number = 0, args?: {}): string {
        const fieldType = this.getType();

        const padding = "    ".repeat(depth);

        let parsedArgs = "";
        if (args != undefined && Object.keys(args).length > 0) {
            const cleanArgs = argTreeToSignature(args)
            parsedArgs ="(" + Object.entries(cleanArgs).map(([key, value]) => `${key}: ${stringifyWithoutKeyQuotes(value)}`).join(", ") + ")";
        }

        const result = "    " + padding + (this.alias || fieldName) + parsedArgs;

        //@ts-ignore
        if (fieldType.prototype instanceof Model || fieldType.prototype instanceof Struct) {
            const loadableType: typeof Model | typeof  Struct = this.getType() as typeof Model | typeof  Struct;
            const contents = loadableType.contentsToGraphQL(fieldName, depth);
            return `${result} {\n${contents}\n    ${padding}}`
        }
        return result;
    }

    /** Parses given data as this field type. Resolves lazily. Returned uninitialized object instantly. reference will be kept at all times.
     * May return newly created model or struct. */
    fromDict(data: {}, fieldName: string, field: FieldInfo, parent: Loadable | null, args: ArgTree, onInitialized: (value: any) => any): GraphQlValue {

        const fieldType = this.getType();

        if (this.list) {
            if (this.hasPrimitiveType()) {
                return data as [];
            }
            const loaded: any[] = [];
            const loadableType: typeof Loadable = this.getType() as typeof Loadable;
            const promises: Promise<unknown>[] = [];

            for (const item of data as []) {
                promises.push(
                    new Promise((resolve, reject) => {
                        const instantValue = loadableType.getOrCreate(item, fieldName, this, parent, args, resolve);
                        loaded.push(instantValue);
                    })
                );
            }
            onInitialized && Promise.all(promises).then(() => onInitialized(loaded));
            // todo: is it ok to push to an array which is not reactive?
            // pretty sure it wont work
            return loaded;
        }

        //@ts-ignore
        if (fieldType.prototype instanceof Struct || fieldType.prototype instanceof Model) {
            const loadableType: typeof Loadable = this.getType() as typeof Loadable;
            const instantValue = loadableType.getOrCreate(data, fieldName, this, parent, args, onInitialized);
            return instantValue;
            //loadableType.fromDict(data, fieldName, this, parent, args);
        }

        return data as Primitive;
    }
}

export const Int = new FieldInfo({type: Number});
export const Str = new FieldInfo({type: String});
export const Bool = new FieldInfo({type: Boolean});

function modelNameToGetter(name: string) {
    return name[0].toLowerCase() + name.slice(1);
}

export function Field(field: FieldInfo | GraphQlType, opts: {alias?: string, list?: boolean} = {}){
    if (field instanceof FieldInfo) {
        return new FieldInfo({type: field._type, ...opts});
    }
    return new FieldInfo({type: field as typeof Loadable | string | PrimitiveType, ...opts});
}

export type ObjID = {obj_id: number | null, entity: string, modifiers: string, dependencies: Array<ObjID>}

function graphQLQuery(modelName: string, objectId: ObjID, fields: {[key: string]: FieldInfo}, args: {[key: string]: any}): string {
    const {obj_id, entity, dependencies, modifiers} = objectId;

    let body = "";

    for (const [key, value] of Object.entries(fields)) {
        const fieldArgs = args ? args[key] : undefined;
        body += value.toGraphQL(value.alias || key, 1, fieldArgs) + "\n";
    }

    return `query {
    ${modelName}(identifier: {
        obj_id: ${obj_id} 
        entity: "${entity}"
        modifiers: "${modifiers}"
        dependencies: ${stringifyWithoutKeyQuotes(dependencies)}
    } ) {\n${body}    }\n}`;
}

export interface PrimitiveObjectId {
    entity: string,
    obj_id: number | null,
}

export type Dependency<M extends typeof Model, T extends typeof Model> = {
    entity: T,
    events: string[],
    where: Partial<{
        [K in keyof InstanceType<M>]: keyof InstanceType<T>
    }>,
    predicate?: (model: InstanceType<T>, changes: {[key: string]: any}, self: InstanceType<M>) => boolean,
}

export function isDependencyAffected(dependency: Dependency<any, any>, model: Loadable, update: StateUpdateMessage) {

    // make sure update type is watched by dependency
    if (dependency.events.length != 0 && !dependency.events.includes(update.update_type)) {
        return false;
    }

    // if dependency has custom predicate, make sure it passes
    if (dependency.predicate && !dependency.predicate(update as any, update.changes || {}, model as any)) {
        return false;
    }

    // there are no constraints on fields
    if (Object.keys(dependency.where).length === 0) {
        return true;
    }

    // make sure update is for the right entity
    for (const ownField in dependency.where) {
        const otherField= dependency.where[ownField] as string;
        const ownValue = model.getValue(ownField);

        if (update.changes == null || update.changes[otherField] !== ownValue) {
            continue;
        }

        return true;
    }

    return false;
}

function declaredDependencyToPrimitiveId(dep: Dependency<any, any>): PrimitiveObjectId {
    return {
        entity: dep.entity.name,
        obj_id: null,
    }
}

function intOrNull(value: string | number | null) {
    if (value === null) {
        return null;
    }
    return parseInt(value.toString());
}

export function objectIdToPrimitive(objectId: ObjID): PrimitiveObjectId {
    return {
        entity: objectId.entity,
        obj_id: intOrNull(objectId.obj_id),
    }
}

abstract class Loadable {
    declare __loadInitiated: boolean;
    declare __values: {[key: string]: any};
    declare __VueProxy: this;
    declare __myProxy: this;
    declare __registeredDependencies: PrimitiveObjectId[];
    declare uniqId: number;

    static __dependencyDeclarations: {[key: string]: Array<Dependency<any, any>>} = {};

    static collectFields(): {[key: string]: FieldInfo} {
        const fields: {[key: string]: FieldInfo}  = {};
        for (const key in this) {
            //@ts-ignore
            if (this[key] instanceof FieldInfo) {
                //@ts-ignore
                fields[key] = this[key];
            }
        }
        return fields;
    }

    static declareDependency<M extends typeof Model, T extends typeof Model>(
        this: M,
        model: T,
        {
            events,
            where,
            predicate
        }: {
            events?: string[],
            where?: Partial<{ [K in keyof InstanceType<M>]: keyof InstanceType<T> }>,
            predicate?: (newVal: InstanceType<T>, changes: {[key: string]: any}, self: InstanceType<M>) => boolean
        }
    ) {
        const dep = createDep(this as any, model, events || [], where || {}, predicate);
        const dependencyDeclarationsForModel = this.__dependencyDeclarations[this.name] || [];
        dependencyDeclarationsForModel.push(dep);
        this.__dependencyDeclarations[this.name] = dependencyDeclarationsForModel;
    }

    private registerDependencyImpl(primitiveId: PrimitiveObjectId, dep: Dependency<any, any> | null) {

        // register locally to send to backend with request,
        // subscribing to this id on server side
        this.__registeredDependencies.push(primitiveId);

        const stringId = primitiveObjectIdToString(primitiveId);

        const entry = [
            dep,
            this
        ] as [Dependency<any, any> | null, Loadable];

        // register in global dependency map
        // to update once event comes
        dependencyMap[stringId] = dependencyMap[stringId] || [];
        dependencyMap[stringId].push(entry);
    }

    registerPrimitiveDependency(objectId: ObjID) {
        this.registerDependencyImpl(objectIdToPrimitive(objectId), null);
    }

    registerDependency(dependsOn: Dependency<any, any>) {
        this.registerDependencyImpl(declaredDependencyToPrimitiveId(dependsOn), dependsOn);
    }

    registerEventDependency(event: string) {
        eventDependencyMap[event] = eventDependencyMap[event] || [];
        eventDependencyMap[event].push(this);
        return this;
    }

    abstract initiateRefresh(): void;

    /** Unlike fromJson method, this method updates a model, rather than a field */
    updateEntireModelWithCompleteJson(response: any, args: ArgTree) {

        if (response == null) {
            console.warn("Can't update model from null response", this);
            return;
        }

        const modelClass: typeof Model = this.constructor as typeof Model;

        for (const [key, value] of Object.entries(modelClass.collectFields())) {
            const fieldArgs = args ? args[key] : undefined;

            const fieldName = value.alias || key;

            if (!(fieldName in response)) {
                console.warn("Field " + fieldName + " not in response", response);
                continue;
            }

            // fromDict returns lazily resolved object
            let parsedValue = value.fromDict(
                response[fieldName],
                key,
                value,
                this,
                fieldArgs,
                () => {}
            );

            // make sure lists reuse same reference
            if (value.list) {
                const listRef = this.getValue(key) as Array<GraphQlValue>;
                while (listRef.length) listRef.pop();
                for (const item of parsedValue as Array<GraphQlValue>) {
                    listRef.push(item);
                }
                parsedValue = listRef;
            }

            this.setValue(key, parsedValue);
        }
        return this;
    }

    // only model has object id
    protected constructor(storeIdentifier: string | null) {

        this.__loadInitiated = false;
        this.__values = {};
        this.__registeredDependencies = [];

        this.uniqId = Math.round(Math.random() * 1000)

        this.__myProxy = new Proxy(this, {

            ownKeys: (target) => {
                const Constr = this.constructor as typeof Loadable;
                const fields = Constr.collectFields();

                return Object.keys(fields);
            },
            get: (target: any, name: string | Symbol) => {

                // we don't intercept symbols
                if (typeof name === "symbol") {
                    return target[name];
                }

                name = name as string;

                const Constr = this.constructor as typeof Loadable;
                const fields = Constr.collectFields();

                if (!Object.prototype.hasOwnProperty.call(fields, name)) {
                    return target[name];
                }

                const field = fields[name as string];

                if (!field) {
                    return target[name as string] as any;
                }

                if (!this.__loadInitiated) {
                    if (this instanceof Model) {
                        this.initiateRefresh();
                    }
                }

                if (field.isPrimitive()) {
                    return this.getValue(name);
                } else {

                    if (field.list) {
                        for (const modelItem of this.getValue(name) as Loadable[]) {
                            if (modelItem && !modelItem.__loadInitiated) {
                                // load models that were not yet initiated
                                modelItem.initiateRefresh();
                            }
                        }
                        return this.getValue(name);
                    } else {
                        // for fields that need to be resolved we add a getter.
                        const existingLoadable = this.getValue(name);

                        // value was already resolved
                        if (existingLoadable && existingLoadable.__loadInitiated) {
                            return this.getValue(name);
                        }

                        if (existingLoadable) {
                            //wbt structs
                            if (existingLoadable instanceof Model) {
                                existingLoadable.initiateRefresh();
                            } else {
                                console.warn("Existing loadable is not a model", existingLoadable);
                            }
                            return existingLoadable;
                        }

                        // this condition makes no sense
                        if (!existingLoadable && this.getValue(name)) {
                            const createdModelValue = field.fromDict(this.getValue(name), name, field, this, {}, () => {});
                            this.setValue(name, createdModelValue);

                            // structs can't be refreshed or queried for that matter, they don't have object id
                            if (createdModelValue instanceof Model) {
                                createdModelValue.initiateRefresh();
                            }
                            return createdModelValue;
                        }
                    }

                    return null;
                }
            },
            set: (target, name, value) => {
                const Constr = this.constructor as typeof Loadable;
                const fields = Constr.collectFields();

                const field = fields[name as string];

                if (field) {
                    throw new Error("Cannot set value on model");
                }
                target[name] = value;
                return true;
            },
        });

        const storeId = storeIdentifier || "" + this.uniqId;

        this.__VueProxy = window.$models.makeReactive(storeId, this as any) as any;

        const modelType = this.constructor as typeof Loadable;

        // initialize lists with empty arrays
        for (const [key, value] of Object.entries(modelType.collectFields())) {
            if (value.list) {
                if (this.getValue(key) == undefined) {
                    this.setValue(key, []);
                } else {
                    console.warn("Prevent list field deletion on", key)
                }

            }
        }
    }

    getValue(name: string): any {
        return this.__VueProxy.__values[name];
    }

    setValue(name: string, value: any): void {
        this.__VueProxy.__values[name] = value;
    }


    /** Update this model with values from JSON. Resolves foreign keys lazily */
    abstract fromDict(
        data: {[key: string]: any},
        fieldName: string,
        field: FieldInfo,
        parent: Loadable,
        args?: {[key: string]: any},
        onDone?: (value: any) => any
    ): this | null;

    /** Possibly create new instance, or take existing instance from store.
     * SHOULD NOT START RECURSIVE RESOLUTION PROCESS. Returns reference to model wrapped by my proxy. */
    static getOrCreate (
        item: any,
        fieldName: string,
        field: FieldInfo,
        parent: Loadable | null,
        args: ArgTree,
        resolve: (value: any) => any,
    ): any | null {
        throw new Error("Method getOrCreate not implemented.");
    }
}

class ComputedField extends FieldInfo {

    args: {[key: string]: any}

    constructor(type: FieldInfo | GraphQlType, opts: {[key: string]: any}, args: {[key: string]: any}) {
        super({type: Field(type, {})._type, ...opts});
        this.args = args;
    }

    toGraphQL(fieldName: string, depth: number = 0, args?: {[key: string]: any}): string {

        if (args != undefined && Object.keys(args).length == 0) {
            // copy args one by one
            for (const [key, value] of Object.entries(this.args)) {
                args["$" + key] = value;
            }
        }
        return super.toGraphQL(fieldName, depth, args);
    }
}

export function Computed(type: FieldInfo, initArgs: {[key: string]: any}): ComputedField {
    return new ComputedField(type, {}, {...initArgs});
}


export class Struct extends Loadable {

    _parent: () => Loadable;

    declare _args: ArgTree;
    declare _field: string;

    constructor(parent: Loadable, field: string, args: ArgTree) {
        super(null);
        this._parent = () => parent;
        this._args = args;
        this._field = field;
        // struct always has __values,
        // because struct can't be queried directly,
        // meaning if it exists, there are values
        // from parent model
        this.__loadInitiated = true;
    }

    initiateRefresh() {
        // structs can't be refreshed, but we can refresh parent
        this._parent().initiateRefresh();
    }

    static getOrCreate(
        item: any,
        fieldName: string,
        field: FieldInfo,
        parent: Loadable | null,
        args: ArgTree,
        resolve: (value: any) => any,
    ): Model | Struct | null {
        const Constr = this as typeof Struct;
        return new Constr(parent as Loadable, fieldName, args).fromDict(item, fieldName, field, parent as Loadable, args, resolve)?.__myProxy || null;
    }

    fromDict(data: {[key: string]: any}, fieldName: string, field: FieldInfo, parent: Loadable, args: {[key: string]: any}, onDone: (value: any) => any): this {
        this.updateEntireModelWithCompleteJson(data, args);
        return this;
    }

    setArg(field: string, arg: any) {
        this._args["$" + field] = arg;
    }
    setArgs(args: {[key: string]: any}) {
        for (const [key, value] of Object.entries(args)) {
            this.setArg(key, value);
        }
    }
    async initiateRefreshWithArgs() {
        const parent = this._parent() as Model;
        await parent.initiateRefresh({
            [this._field]: this._args
        });
    }

    static contentsToGraphQL(fieldName: string, depth: number = 0): string {
        const structType = this as typeof Struct;

        let result = "";

        for (const [fieldName, type] of Object.entries(structType.collectFields())) {
            result += type.toGraphQL(type.alias || fieldName, depth) + "\n";
        }
        // remove last newline
        result = result.slice(0, -1)

        return result;
    }
}

export interface PageType<T> {

    [Symbol.iterator](): IterableIterator<T>;
    setPage(page: number): Promise<void>;
    setFilters(filters: {[key: string]: any}): Promise<void>;
    length: number;
    count: number;
}


export function Page(type: GraphQlType, opts: {[key: string]: any} = {}) {
    class PageG extends Struct {

        constructor(parent: Loadable, field: string, args: {[key: string]: any}) {
            super(parent, field, args);
        }

        static items = Field(type, {list: true});
        static count = Field(Int, opts);

        declare items: any[];
        declare count: number;

        async setPage(page: Number) {
            this.setArg("page", page);
            await this.initiateRefreshWithArgs();
        }

        async setFilters(filters: {[key: string]: any}) {
            this.setArgs(filters);
            await this.initiateRefreshWithArgs();
        }

        [Symbol.iterator] () {
            return this.getValue('items')[Symbol.iterator]();
        }

        get length() {
            return this.getValue('items').length;
        }
    }

    return Field(PageG, {});
}


export class Model extends Loadable {

    declare objectID: ObjID;

    constructor(objectID: ObjID, unique: boolean = true) {
        // if model is unique, we use object id as store identifier, that way this same model can be
        // retrieved from store by different queries
        super(unique ? objectIdToString(objectID) : null);
        this.objectID = objectID;

        // todo: here we register dependencies of object id and later in formGQLRequest we gather
        // dependencies of object id and registered dependencies resulting in duplicates.

        // register dependency on own id
        this.__VueProxy.registerPrimitiveDependency(objectID);

        // register dependency on dependencies, passed from backend
        // (deprecated?)
        for (const dependency of objectID.dependencies) {
            this.__VueProxy.registerPrimitiveDependency(dependency);
        }

        const Constr = this.constructor as typeof Model;

        // register statically declared dependencies
        // does nothing but copies static dependencies for this instance
        for (const depDecl of Constr.__dependencyDeclarations[Constr.name] || []) {
            this.__VueProxy.registerDependency(depDecl);
        }
    }

    findDependency(entity: string) {
        for (const dependency of this.objectID.dependencies) {
            const normalE1 = dependency.entity.toLowerCase().replace("_", "");
            const normalE2 = entity.toLowerCase().replace("_", "");
            if (normalE1 == normalE2) {
                return dependency;
            }
        }

        for (const dependency of this.__registeredDependencies) {
            const normalE1 = dependency.entity.toLowerCase().replace("_", "");
            const normalE2 = entity.toLowerCase().replace("_", "");
            if (normalE1 == normalE2) {
                return dependency;
            }
        }

        return null;
    }

    static getOrCreate(
        item: any,
        fieldName: string,
        field: FieldInfo,
        parent: Loadable | null,
        args: ArgTree,
        resolve: (value: any) => any
    ): Model | Struct | null {
        // models are stored in registry
        const ref = ModelFactory(item, {unique: true});

        if (ref == undefined) {
            return null;
        }
        // or maybe ref.__reactive;
        return ref.__myProxy; //window.$models.get(item);
    }


    static Find<T>(this: typeof Model & {new(o: any): T}, id: number, {dependencies=[], unique=true}: {dependencies: ObjID[], unique: boolean} = {unique: true, dependencies: []}): T {

        const objId = {obj_id: id, entity: this.name, dependencies: dependencies, modifiers: '[]'};

        if (!unique) {
            return ModelFactory(objId, {unique: false})?.__VueProxy as any;
        }

        const val = this.getOrCreate(
            objId,
            "<Find() call>",
            null as any,
            null,
            {},
            () => {}
        )

        return val as any;
    }

    static createView(deps: ObjID[]) {
        const view = new this(
            {
                obj_id: null,
                entity: this.name,
                dependencies: deps,
                modifiers: '[]'
            },
            false // views are not unique because new instance is created with every request
            // as you can see. todo: maybe some views can be reused?
        );

        const reactive = view.__myProxy; //window.$models.get(view.objectID);
        if (reactive instanceof Model) {
            reactive.initiateRefresh();
        } else {
            console.error("Not a model", reactive)
            throw new Error("Struct can't be used as view, received");
        }

        // @ts-ignore
        return reactive as Model;
    }

    // async safeWaitLoaded() {
    //     if (this._isBeingAwaited === true) {
    //         return;
    //     }
    //     this._isBeingAwaited = true;
    //     await this.initPromise;
    //     this._isBeingAwaited = false;
    // }

    static formGraphQLRequest(objectId: ObjID, args: {}): string {
        // lowercase first letter
        const getterName = modelNameToGetter(this.name);
        return graphQLQuery(getterName, objectId, this.collectFields(), args);
    }

    async initiateRefresh(args?: {}) {
        this.__loadInitiated = true;

        const modelType: typeof Model = this.constructor as typeof Model;

        const argTree = new ArgTree(args || {});

        if (typeof modelType.formGraphQLRequest != 'function') {
            console.error("Model doesn't have a formGraphQLRequest method", modelType);
            return;
        }

        // create object id that contains extended list of dependencies
        const completeObjectId = {
            entity: this.objectID.entity,
            obj_id: this.objectID.obj_id,
            dependencies: [
                ...this.objectID.dependencies,
                ...this.__registeredDependencies,
            ],
        } as ObjID;
        const query = modelType.formGraphQLRequest(completeObjectId, argTree);

        const response = await fetch("http://" + window.location.hostname + ":8000" + "/graphql/", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "session_id": sessionId,
                "Authorization": localStorage.sessionAuthKey,
            },

            body: JSON.stringify({query})
        });

        const data = await response.json();
        this.updateEntireModelWithCompleteJson(data.data[modelNameToGetter(this.constructor.name)], argTree);

    }

    static contentsToGraphQL(fieldName: string, depth: number = 0): string {
        const padding = "    ".repeat(depth);
        return `        ${padding}obj_id
        ${padding}entity
        ${padding}modifiers
        ${padding}dependencies { obj_id entity modifiers }`;
    }

    fromDict(data: {[key: string]: any}, fieldName: string, field: FieldInfo, parent: Loadable, args: {}, onLoaded?: (value: any) => void): this | null {
        //ignores object id passed? is it ok?
        if (data == null) {
            onLoaded && onLoaded(null);
            return null;
        }

        this.initiateRefresh(args).then(() => onLoaded && onLoaded(this));
        return this;
        // model.safeWaitLoaded().then(() => onLoaded && onLoaded(model));
        // return model;
    }
}


export abstract class ModelManager {

    models: {[key: string]: Model | Struct} = {};

    constructor() {
        this.models = {};
    }

    abstract makeReactive<T extends Model | Struct>(modelKey: string, model: T): T;

}


// window.registry = modelRegistry;

/** Get reference to model or create a new one. Does not initialize model, returns empty reference.
 *
 * @param objectId Model identifier to get
 * @param unique If false, will always create new model instance.
 *
 * @returns Model reference or null if objectId is null
 * */
function ModelFactory(objectId: ObjID, {unique}: {unique: boolean}): Model | Struct | null {
    if (objectId == null) {
        return null;
    }

    // for unique models attempt to find cached model
    if (unique) {
        // get keys from registry
        const item = window.$models.models[objectIdToString(objectId)];
        if (item !== undefined) {
            return item;
        }
    }

    const modelClass = modelTypes[objectId.entity] as typeof Model;

    if (!modelClass) {
        throw "Model class not found for entity " + objectId.entity + "(" + JSON.stringify(objectId) + ")";
    }

    const model = new modelClass(objectId, unique);

    return model.__VueProxy;
}

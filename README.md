# Blazelink-js

## A client library for Blazelink

for more context see [Blazelink](https://github.com/vdaysky/blazelink)

---

## Model Declaration

Your models should match the models you defiled on the server side. They may omit some fields, but they obviously can't 
add any fields that were not declared on the server. Both virtual tables and usual tables here should extend the Model 
class.

Let's declare some models

```typescript
class User extends Model {

    declare id: number;
    declare _name: string;
    declare events: PageType<GameEvent>;

    static id = Int;
    static _name = Field(Str, {alias: 'name'})
    static events = Computed(Page('GameEvent'), {page: 0, size: 5})

}

class Team extends Model {
    declare id: number;
    declare _name: string;

    static id = Int;
    static _name = Field(Str, {alias: 'name'})
}

class Game extends Model {

    declare id: number;
    declare _name: string;

    static id = Int;
    static _name = Field(Str, {alias: 'name'})
}

class GameEvent extends Model {
    declare id: number;
    declare player_id: number;
    declare game_id: number;
    declare type: string;
    declare player: User;
    declare game: Game;

    static id = Int;
    static type = Str
    static player = Field(User)
    static game = Field(Game)
}
```

Now, lets declare what dependencies those models have, meaning when they should be updated.

```typescript
User.declareDependency(
    GameEvent,
    {
        events: ['Create'],
        where: {
            id: 'player_id'
        }
    }
)
```

In this example we told blazelink that User model should be updated when GameEvent is created with player_id field 
matching User.id. We could declare it just as User.declareDependency(GameEvent), but then it would be updated on any
GameEvent change, which is not exactly efficient. Note that those constraints would not prevent websocket update
message coming to the frontend on any GameEvent update, but it would prevent the model from making graphql query to the 
server.

Now, let's complete the configuration:

```typescript
class MyModelManager extends ModelManager {

    makeReactive<T extends Model | Struct>(modelKey: string, model: T): T {
        this.models[modelKey] = model;
        return model;
    }

}

window.$models = new MyModelManager();
registerModelType(User);
registerModelType(Team);
registerModelType(Game);
registerModelType(GameEvent);
```
Here I am implementing the ModelManager class, which is responsible for storing models and making them reactive.
In Vue3 implementation of `makeReactive` would be very simple:

```typescript
makeReactive<T extends Model | Struct>(modelKey: string, model: T): T {
    const r = reactive(model);
    this.models[modelKey] = r;
    return r;
}
```

but since I want to simply test it in browser console, I won't make this model reactive.

## Querying

Now, let's query some data

```typescript
const user = User.Find(1);
```

This will return a user model. Simply calling Find will not initiate any graphql queries, though. It will only create a
model instance. Once you will try to access any property on user model, that's when the query will be made. Worth 
mentioning that foreign key properties will be lazy-loaded as well. Another feature of the library is caching. By default,
Model.Find will return a unique model. meaning that if you call Model.Find twice with same id, you will get the same model 
instance.

You can also add dependencies on model instances. For example, let's query a GameEvent object and make sure it is updated 
with player #1 and game #2:

```typescript
const event = GameEvent.Find(1, {
    dependencies: {
        {
            obj_id: 1,
            entity: 'User'
        }, 
        {
            obj_id: 2,
            entity: 'Game'
        }
    }   
});
```

### Pagination

if field is paginated, it would have iterator symbol allowing to access items of the page, length property, giving access
to underlying array length, count property, giving total count of items, setPage method, allowing to go to page by index 
and setFilters method, allowing to pass additional arguments to query.

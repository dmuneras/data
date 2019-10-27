import { Promise, resolve } from 'rsvp';
import { run, next } from '@ember/runloop';
import { setupTest } from 'ember-qunit';
import Ember from 'ember';
import testInDebug from 'dummy/tests/helpers/test-in-debug';
import deepCopy from 'dummy/tests/helpers/deep-copy';
import { module, test } from 'qunit';
import RESTAdapter from '@ember-data/adapter/rest';
import RESTSerializer from '@ember-data/serializer/rest';
import JSONAPISerializer from '@ember-data/serializer/json-api';
import { settled } from '@ember/test-helpers';

import DS from 'ember-data';

const Person = DS.Model.extend({
  name: DS.attr('string'),
  cars: DS.hasMany('car', { async: false }),
});

Person.reopenClass({
  toString() {
    return 'Person';
  },
});

const Car = DS.Model.extend({
  make: DS.attr('string'),
  model: DS.attr('string'),
  person: DS.belongsTo('person', { async: false }),
});

Car.reopenClass({
  toString() {
    return 'Car';
  },
});

function ajaxResponse(value) {
  return function(url, verb, hash) {
    return resolve(deepCopy(value));
  };
}

function tap(obj, methodName, callback) {
  let old = obj[methodName];

  let summary = { called: [] };

  obj[methodName] = function() {
    let result = old.apply(obj, arguments);
    if (callback) {
      callback.apply(obj, arguments);
    }
    summary.called.push(arguments);
    return result;
  };

  return summary;
}

module('integration/store - destroy', function(hooks) {
  setupTest(hooks);

  hooks.beforeEach(function() {
    this.owner.register('model:car', Car);
    this.owner.register('model:person', Person);

    this.owner.register('adapter:application', DS.Adapter.extend());
    this.owner.register('serializer:application', JSONAPISerializer.extend());
  });

  test("destroying record during find doesn't cause unexpected error (find resolves)", async function(assert) {
    assert.expect(1);

    let store = this.owner.lookup('service:store');

    let TestAdapter = DS.Adapter.extend({
      findRecord(store, type, id, snapshot) {
        return new Promise((resolve, reject) => {
          store.unloadAll(type.modelName);
          resolve({
            data: {
              type: 'car',
              id: '1',
              attributes: {},
            },
          });
        });
      },
    });

    this.owner.register('adapter:application', TestAdapter);

    let type = 'car';
    let id = '1';

    try {
      await store.findRecord(type, id);
      assert.ok(true, 'we have no error');
    } catch (e) {
      assert.ok(false, `we should have no error, received: ${e.message}`);
    }
  });

  test("destroying record during find doesn't cause unexpected error (find rejects)", async function(assert) {
    assert.expect(1);

    let store = this.owner.lookup('service:store');

    let TestAdapter = DS.Adapter.extend({
      findRecord(store, type, id, snapshot) {
        return new Promise((resolve, reject) => {
          store.unloadAll(type.modelName);
          reject(new Error('Record Was Not Found'));
        });
      },
    });

    this.owner.register('adapter:application', TestAdapter);

    let type = 'car';
    let id = '1';

    try {
      await store.findRecord(type, id);
      assert.ok(false, 'we have no error, but we should');
    } catch (e) {
      assert.strictEqual(e.message, 'Record Was Not Found', `we should have a NotFound error`);
    }
  });

  testInDebug('find calls do not resolve when the store is destroyed', async function(assert) {
    assert.expect(2);

    let store = this.owner.lookup('service:store');
    let next;
    let nextPromise = new Promise(resolve => (next = resolve));
    let TestAdapter = DS.Adapter.extend({
      findRecord() {
        next();
        nextPromise = new Promise(resolve => {
          next = resolve;
        }).then(() => {
          return {
            data: { type: 'car', id: '1' },
          };
        });
        return nextPromise;
      },
    });

    this.owner.register('adapter:application', TestAdapter);

    // needed for LTS 2.16
    Ember.Test.adapter.exception = e => {
      throw e;
    };

    store.shouldTrackAsyncRequests = true;
    store.push = function() {
      assert('The test should have destroyed the store by now', store.isDestroyed);

      throw new Error("We shouldn't be pushing data into the store when it is destroyed");
    };
    let requestPromise = store.findRecord('car', '1');

    await nextPromise;

    assert.throws(() => {
      run(() => store.destroy());
    }, /Async Request leaks detected/);

    next();

    await nextPromise;

    // ensure we allow the internal store promises
    // to flush, potentially pushing data into the store
    await settled();
    assert.ok(true, 'we made it to the end');
    await requestPromise;
    assert.ok(false, 'we should never make it here');
  });

  test('destroying the store correctly cleans everything up', async function(assert) {
    let car, person;
    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.shouldBackgroundReloadRecord = () => false;

    store.push({
      data: [
        {
          type: 'car',
          id: '1',
          attributes: {
            make: 'BMC',
            model: 'Mini',
          },
          relationships: {
            person: {
              data: { type: 'person', id: '1' },
            },
          },
        },
        {
          type: 'person',
          id: '1',
          attributes: {
            name: 'Tom Dale',
          },
          relationships: {
            cars: {
              data: [{ type: 'car', id: '1' }],
            },
          },
        },
      ],
    });

    car = store.peekRecord('car', '1');
    person = store.peekRecord('person', '1');

    let personWillDestroy = tap(person, 'willDestroy');
    let carWillDestroy = tap(car, 'willDestroy');
    let carsWillDestroy = tap(car.get('person.cars'), 'willDestroy');

    adapter.query = function() {
      return {
        data: [
          {
            id: '2',
            type: 'person',
            attributes: { name: 'Yehuda' },
          },
        ],
      };
    };

    let adapterPopulatedPeople = await store.query('person', {
      someCrazy: 'query',
    });

    let adapterPopulatedPeopleWillDestroy = tap(adapterPopulatedPeople, 'willDestroy');

    await store.findRecord('person', '2');

    assert.equal(personWillDestroy.called.length, 0, 'expected person.willDestroy to not have been called');
    assert.equal(carWillDestroy.called.length, 0, 'expected car.willDestroy to not have been called');
    assert.equal(carsWillDestroy.called.length, 0, 'expected cars.willDestroy to not have been called');
    assert.equal(
      adapterPopulatedPeopleWillDestroy.called.length,
      0,
      'expected adapterPopulatedPeople.willDestroy to not have been called'
    );
    assert.equal(car.get('person'), person, "expected car's person to be the correct person");
    assert.equal(person.get('cars.firstObject'), car, " expected persons cars's firstRecord to be the correct car");

    store.destroy();

    await settled();

    assert.equal(personWillDestroy.called.length, 1, 'expected person to have received willDestroy once');
    assert.equal(carWillDestroy.called.length, 1, 'expected car to have received willDestroy once');
    assert.equal(carsWillDestroy.called.length, 1, 'expected person.cars to have received willDestroy once');
    assert.equal(
      adapterPopulatedPeopleWillDestroy.called.length,
      1,
      'expected adapterPopulatedPeople to receive willDestroy once'
    );
  });
});

module('integration/store - findRecord', function(hooks) {
  setupTest(hooks);

  hooks.beforeEach(function() {
    this.owner.register('model:car', Car);
    this.owner.register('adapter:application', RESTAdapter.extend());
    this.owner.register('serializer:application', RESTSerializer.extend());
  });

  test('store#findRecord fetches record from server when cached record is not present', function(assert) {
    assert.expect(2);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 20,
          make: 'BMC',
          model: 'Mini',
        },
      ],
    });

    let cachedRecordIsPresent = store.hasRecordForId('car', 20);
    assert.ok(!cachedRecordIsPresent, 'Car with id=20 should not exist');

    return run(() => {
      return store.findRecord('car', 20).then(car => {
        assert.equal(car.get('make'), 'BMC', 'Car with id=20 is now loaded');
      });
    });
  });

  test('store#findRecord returns cached record immediately and reloads record in the background', async function(assert) {
    assert.expect(4);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');
    adapter.shouldReloadRecord = () => false;
    adapter.shouldBackgroundReloadRecord = () => true;

    store.push({
      data: {
        type: 'car',
        id: '1',
        attributes: {
          make: 'BMC',
          model: 'Mini',
        },
      },
    });

    adapter.ajax = () => {
      return new Promise(resolve => setTimeout(resolve, 1)).then(() => {
        return {
          cars: [
            {
              id: '1',
              make: 'BMC',
              model: 'Princess',
            },
          ],
        };
      });
    };

    const promiseCar = store.findRecord('car', '1');
    const car = await promiseCar;

    assert.equal(promiseCar.get('model'), 'Mini', 'promiseCar is from cache');
    assert.equal(car.get('model'), 'Mini', 'car record is returned from cache');

    await settled();

    assert.equal(promiseCar.get('model'), 'Princess', 'promiseCar is updated');
    assert.equal(car.get('model'), 'Princess', 'Updated car record is returned');
  });

  test('store#findRecord { reload: true } ignores cached record and reloads record from server', function(assert) {
    assert.expect(2);

    const testAdapter = DS.RESTAdapter.extend({
      shouldReloadRecord(store, type, id, snapshot) {
        assert.ok(false, 'shouldReloadRecord should not be called when { reload: true }');
      },
    });

    this.owner.register('adapter:application', testAdapter);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    run(() => {
      store.push({
        data: {
          type: 'car',
          id: '1',
          attributes: {
            make: 'BMC',
            model: 'Mini',
          },
        },
      });
    });

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 1,
          make: 'BMC',
          model: 'Princess',
        },
      ],
    });

    let cachedCar = store.peekRecord('car', 1);
    assert.equal(cachedCar.get('model'), 'Mini', 'cached car has expected model');

    return run(() => {
      return store.findRecord('car', 1, { reload: true }).then(car => {
        assert.equal(car.get('model'), 'Princess', 'cached record ignored, record reloaded via server');
      });
    });
  });

  test('store#findRecord { reload: true } ignores cached record and reloads record from server even after previous findRecord', function(assert) {
    assert.expect(5);
    let calls = 0;

    const testAdapter = DS.JSONAPIAdapter.extend({
      shouldReloadRecord(store, type, id, snapshot) {
        assert.ok(false, 'shouldReloadRecord should not be called when { reload: true }');
      },
      findRecord() {
        calls++;
        return resolve({
          data: {
            type: 'car',
            id: '1',
            attributes: {
              make: 'BMC',
              model: calls === 1 ? 'Mini' : 'Princess',
            },
          },
        });
      },
    });

    this.owner.register('adapter:application', testAdapter);
    this.owner.register('serializer:application', JSONAPISerializer.extend());

    let store = this.owner.lookup('service:store');

    let car = run(() => store.findRecord('car', '1'));

    assert.equal(calls, 1, 'We made one call to findRecord');
    assert.equal(car.get('model'), 'Mini', 'cached car has expected model');

    run(() => {
      let promiseCar = store.findRecord('car', 1, { reload: true });

      assert.ok(promiseCar.get('model') === undefined, `We don't have early access to local data`);
    });

    assert.equal(calls, 2, 'We made a second call to findRecord');
    assert.equal(car.get('model'), 'Princess', 'cached record ignored, record reloaded via server');
  });

  test('store#findRecord { backgroundReload: false } returns cached record and does not reload in the background', function(assert) {
    assert.expect(2);

    let testAdapter = DS.RESTAdapter.extend({
      shouldBackgroundReloadRecord() {
        assert.ok(false, 'shouldBackgroundReloadRecord should not be called when { backgroundReload: false }');
      },

      findRecord() {
        assert.ok(false, 'findRecord() should not be called when { backgroundReload: false }');
      },
    });

    this.owner.register('adapter:application', testAdapter);

    let store = this.owner.lookup('service:store');

    run(() => {
      store.push({
        data: {
          type: 'car',
          id: '1',
          attributes: {
            make: 'BMC',
            model: 'Mini',
          },
        },
      });
    });

    run(() => {
      store.findRecord('car', 1, { backgroundReload: false }).then(car => {
        assert.equal(car.get('model'), 'Mini', 'cached car record is returned');
      });
    });

    run(() => {
      let car = store.peekRecord('car', 1);
      assert.equal(car.get('model'), 'Mini', 'car record was not reloaded');
    });
  });

  test('store#findRecord { backgroundReload: true } returns cached record and reloads record in background', function(assert) {
    assert.expect(2);

    let testAdapter = DS.RESTAdapter.extend({
      shouldBackgroundReloadRecord() {
        assert.ok(false, 'shouldBackgroundReloadRecord should not be called when { backgroundReload: true }');
      },
    });

    this.owner.register('adapter:application', testAdapter);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    run(() => {
      store.push({
        data: {
          type: 'car',
          id: '1',
          attributes: {
            make: 'BMC',
            model: 'Mini',
          },
        },
      });
    });

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 1,
          make: 'BMC',
          model: 'Princess',
        },
      ],
    });

    run(() => {
      store.findRecord('car', 1, { backgroundReload: true }).then(car => {
        assert.equal(car.get('model'), 'Mini', 'cached car record is returned');
      });
    });

    run(() => {
      let car = store.peekRecord('car', 1);
      assert.equal(car.get('model'), 'Princess', 'car record was reloaded');
    });
  });

  test('store#findRecord { backgroundReload: false } is ignored if adapter.shouldReloadRecord is true', function(assert) {
    assert.expect(2);

    let testAdapter = DS.RESTAdapter.extend({
      shouldReloadRecord() {
        return true;
      },

      shouldBackgroundReloadRecord() {
        assert.ok(false, 'shouldBackgroundReloadRecord should not be called when adapter.shouldReloadRecord = true');
      },
    });

    this.owner.register('adapter:application', testAdapter);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    run(() => {
      store.push({
        data: {
          type: 'car',
          id: '1',
          attributes: {
            make: 'BMC',
            model: 'Mini',
          },
        },
      });
    });

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 1,
          make: 'BMC',
          model: 'Princess',
        },
      ],
    });

    run(() => {
      let car = store.peekRecord('car', 1);
      assert.equal(car.get('model'), 'Mini', 'Car record is initially a Mini');
    });

    run(() => {
      store.findRecord('car', 1, { backgroundReload: false }).then(car => {
        assert.equal(car.get('model'), 'Princess', 'Car record is reloaded immediately (not in the background)');
      });
    });
  });

  testInDebug(
    'store#findRecord call with `id` of type different than non-empty string or number should trigger an assertion',
    function(assert) {
      const badValues = ['', undefined, null, NaN, false];
      assert.expect(badValues.length);

      let store = this.owner.lookup('service:store');

      run(() => {
        badValues.map(item => {
          assert.expectAssertion(() => {
            store.findRecord('car', item);
          }, `Expected id to be a string or number, received ${String(item)}`);
        });
      });
    }
  );
});

module('integration/store - findAll', function(hooks) {
  setupTest(hooks);

  hooks.beforeEach(function() {
    this.owner.register('model:car', Car);
    this.owner.register('adapter:application', RESTAdapter.extend());
    this.owner.register('serializer:application', RESTSerializer.extend());
  });

  test('Using store#findAll with no records triggers a query', function(assert) {
    assert.expect(2);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 1,
          make: 'BMC',
          model: 'Mini',
        },
        {
          id: 2,
          make: 'BMCW',
          model: 'Isetta',
        },
      ],
    });

    let cars = store.peekAll('car');
    assert.ok(!cars.get('length'), 'There is no cars in the store');

    return run(() => {
      return store.findAll('car').then(cars => {
        assert.equal(cars.get('length'), 2, 'Two car were fetched');
      });
    });
  });

  test('Using store#findAll with existing records performs a query in the background, updating existing records and returning new ones', function(assert) {
    assert.expect(4);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    run(() => {
      store.push({
        data: {
          type: 'car',
          id: '1',
          attributes: {
            make: 'BMC',
            model: 'Mini',
          },
        },
      });
    });

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 1,
          make: 'BMC',
          model: 'New Mini',
        },
        {
          id: 2,
          make: 'BMCW',
          model: 'Isetta',
        },
      ],
    });

    let cars = store.peekAll('car');
    assert.equal(cars.get('length'), 1, 'There is one car in the store');

    let waiter = run(() => {
      return store.findAll('car').then(cars => {
        assert.equal(cars.get('length'), 1, 'Store resolves with the existing records');
      });
    });

    run(() => {
      let cars = store.peekAll('car');
      assert.equal(cars.get('length'), 2, 'There is 2 cars in the store now');
      let mini = cars.findBy('id', '1');
      assert.equal(mini.get('model'), 'New Mini', 'Existing records have been updated');
    });

    return waiter;
  });

  test('store#findAll { backgroundReload: false } skips shouldBackgroundReloadAll, returns cached records & does not reload in the background', function(assert) {
    assert.expect(4);

    let testAdapter = DS.RESTAdapter.extend({
      shouldBackgroundReloadAll() {
        assert.ok(false, 'shouldBackgroundReloadAll should not be called when { backgroundReload: false }');
      },

      findAll() {
        assert.ok(false, 'findAll() should not be called when { backgroundReload: true }');
      },
    });

    this.owner.register('adapter:application', testAdapter);

    let store = this.owner.lookup('service:store');

    run(() => {
      store.push({
        data: {
          type: 'car',
          id: '1',
          attributes: {
            make: 'BMC',
            model: 'Mini',
          },
        },
      });
    });

    run(() => {
      store.findAll('car', { backgroundReload: false }).then(cars => {
        assert.equal(cars.get('length'), 1, 'single cached car record is returned');
        assert.equal(cars.get('firstObject.model'), 'Mini', 'correct cached car record is returned');
      });
    });

    run(() => {
      let cars = store.peekAll('car');
      assert.equal(cars.get('length'), 1, 'single cached car record is returned again');
      assert.equal(cars.get('firstObject.model'), 'Mini', 'correct cached car record is returned again');
    });
  });

  test('store#findAll { backgroundReload: true } skips shouldBackgroundReloadAll, returns cached records, & reloads in background', function(assert) {
    assert.expect(5);

    let testAdapter = DS.RESTAdapter.extend({
      shouldBackgroundReloadAll() {
        assert.ok(false, 'shouldBackgroundReloadAll should not be called when { backgroundReload: true }');
      },
    });

    this.owner.register('adapter:application', testAdapter);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    run(() => {
      store.push({
        data: {
          type: 'car',
          id: '1',
          attributes: {
            make: 'BMC',
            model: 'Mini',
          },
        },
      });
    });

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 1,
          make: 'BMC',
          model: 'New Mini',
        },
        {
          id: 2,
          make: 'BMCW',
          model: 'Isetta',
        },
      ],
    });

    run(() => {
      store.findAll('car', { backgroundReload: true }).then(cars => {
        assert.equal(cars.get('length'), 1, 'single cached car record is returned');
        assert.equal(cars.get('firstObject.model'), 'Mini', 'correct cached car record is returned');
      });
    });

    run(() => {
      let cars = store.peekAll('car');
      assert.equal(cars.get('length'), 2, 'multiple cars now in the store');
      assert.equal(cars.get('firstObject.model'), 'New Mini', 'existing record updated correctly');
      assert.equal(cars.get('lastObject.model'), 'Isetta', 'new record added to the store');
    });
  });

  test('store#findAll { backgroundReload: false } is ignored if adapter.shouldReloadAll is true', function(assert) {
    assert.expect(5);

    let testAdapter = DS.RESTAdapter.extend({
      shouldReloadAll() {
        return true;
      },

      shouldBackgroundReloadAll() {
        assert.ok(false, 'shouldBackgroundReloadAll should not be called when adapter.shouldReloadAll = true');
      },
    });

    this.owner.register('adapter:application', testAdapter);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    run(() => {
      store.push({
        data: {
          type: 'car',
          id: '1',
          attributes: {
            make: 'BMC',
            model: 'Mini',
          },
        },
      });
    });

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 1,
          make: 'BMC',
          model: 'New Mini',
        },
        {
          id: 2,
          make: 'BMCW',
          model: 'Isetta',
        },
      ],
    });

    run(() => {
      let cars = store.peekAll('car');
      assert.equal(cars.get('length'), 1, 'one car in the store');
      assert.equal(cars.get('firstObject.model'), 'Mini', 'correct car is in the store');
    });

    return run(() => {
      return store.findAll('car', { backgroundReload: false }).then(cars => {
        assert.equal(cars.get('length'), 2, 'multiple car records are returned');
        assert.equal(cars.get('firstObject.model'), 'New Mini', 'initial car record was updated');
        assert.equal(cars.get('lastObject.model'), 'Isetta', 'second car record was loaded');
      });
    });
  });

  test('store#findAll should eventually return all known records even if they are not in the adapter response', function(assert) {
    assert.expect(5);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    run(() => {
      store.push({
        data: [
          {
            type: 'car',
            id: '1',
            attributes: {
              make: 'BMC',
              model: 'Mini',
            },
          },
          {
            type: 'car',
            id: '2',
            attributes: {
              make: 'BMCW',
              model: 'Isetta',
            },
          },
        ],
      });
    });

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 1,
          make: 'BMC',
          model: 'New Mini',
        },
      ],
    });

    let cars = store.peekAll('car');
    assert.equal(cars.get('length'), 2, 'There is two cars in the store');

    let waiter = run(() => {
      return store.findAll('car').then(cars => {
        assert.equal(cars.get('length'), 2, 'It returns all cars');

        let carsInStore = store.peekAll('car');
        assert.equal(carsInStore.get('length'), 2, 'There is 2 cars in the store');
      });
    });

    run(() => {
      let cars = store.peekAll('car');
      let mini = cars.findBy('id', '1');
      assert.equal(mini.get('model'), 'New Mini', 'Existing records have been updated');

      let carsInStore = store.peekAll('car');
      assert.equal(carsInStore.get('length'), 2, 'There is 2 cars in the store');
    });

    return waiter;
  });

  test('Using store#fetch on an empty record calls find', function(assert) {
    assert.expect(2);

    this.owner.register('model:person', Person);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.ajax = ajaxResponse({
      cars: [
        {
          id: 20,
          make: 'BMCW',
          model: 'Mini',
        },
      ],
    });

    run(() => {
      store.push({
        data: {
          type: 'person',
          id: '1',
          attributes: {
            name: 'Tom Dale',
          },
          relationships: {
            cars: {
              data: [{ type: 'car', id: '20' }],
            },
          },
        },
      });
    });

    let car = store.recordForId('car', 20);
    assert.ok(car.get('isEmpty'), 'Car with id=20 should be empty');

    return run(() => {
      return store.findRecord('car', 20, { reload: true }).then(car => {
        assert.equal(car.get('make'), 'BMCW', 'Car with id=20 is now loaded');
      });
    });
  });

  test('Using store#adapterFor should not throw an error when looking up the application adapter', function(assert) {
    assert.expect(1);

    let store = this.owner.lookup('service:store');

    run(() => {
      let applicationAdapter = store.adapterFor('application');
      assert.ok(applicationAdapter);
    });
  });

  test('Using store#serializerFor should not throw an error when looking up the application serializer', function(assert) {
    assert.expect(1);

    let store = this.owner.lookup('service:store');

    run(() => {
      let applicationSerializer = store.serializerFor('application');
      assert.ok(applicationSerializer);
    });
  });
});

module('integration/store - deleteRecord', function(hooks) {
  setupTest(hooks);

  hooks.beforeEach(function() {
    this.owner.register('model:person', Person);
    this.owner.register('model:car', Car);
    this.owner.register('adapter:application', RESTAdapter.extend());
    this.owner.register('serializer:application', RESTSerializer.extend());
  });

  test('Using store#deleteRecord should mark the model for removal', function(assert) {
    assert.expect(3);

    let store = this.owner.lookup('service:store');

    let person;

    run(() => {
      store.push({
        data: {
          type: 'person',
          id: '1',
          attributes: {
            name: 'Tom Dale',
          },
        },
      });
      person = store.peekRecord('person', 1);
    });

    assert.ok(store.hasRecordForId('person', 1), 'expected the record to be in the store');

    let personDeleteRecord = tap(person, 'deleteRecord');

    run(() => store.deleteRecord(person));

    assert.equal(personDeleteRecord.called.length, 1, 'expected person.deleteRecord to have been called');
    assert.ok(person.get('isDeleted'), 'expect person to be isDeleted');
  });

  test('Store should accept a null value for `data`', function(assert) {
    assert.expect(0);

    let store = this.owner.lookup('service:store');

    run(() => {
      store.push({
        data: null,
      });
    });
  });

  testInDebug('store#findRecord that returns an array should assert', function(assert) {
    const ApplicationAdapter = DS.JSONAPIAdapter.extend({
      findRecord() {
        return { data: [] };
      },
    });

    this.owner.register('adapter:application', ApplicationAdapter);
    this.owner.register('serializer:application', JSONAPISerializer.extend());

    let store = this.owner.lookup('service:store');

    assert.expectAssertion(() => {
      run(() => {
        store.findRecord('car', 1);
      });
    }, /expected the primary data returned from a 'findRecord' response to be an object but instead it found an array/);
  });

  testInDebug('store#didSaveRecord should assert when the response to a save does not include the id', function(
    assert
  ) {
    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.createRecord = function() {
      return {};
    };

    let car = store.createRecord('car');

    assert.expectAssertion(() => {
      run(() => car.save());
    }, /Your car record was saved to the server, but the response does not have an id and no id has been set client side. Records must have ids. Please update the server response to provide an id in the response or generate the id on the client side either before saving the record or while normalizing the response./);

    // This is here to transition the model out of the inFlight state to avoid
    // throwing another error when the test context is torn down, which tries
    // to unload the record, which is not allowed when record is inFlight.
    car._internalModel.transitionTo('loaded.saved');
  });
});

module('integration/store - queryRecord', function(hooks) {
  setupTest(hooks);

  hooks.beforeEach(function() {
    this.owner.register('model:car', Car);
    this.owner.register('adapter:application', DS.Adapter.extend());
    this.owner.register('serializer:application', JSONAPISerializer.extend());
  });

  testInDebug('store#queryRecord should assert when normalized payload of adapter has an array of data', function(
    assert
  ) {
    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');
    let serializer = store.serializerFor('application');

    adapter.queryRecord = function() {
      return {
        cars: [{ id: 1 }],
      };
    };

    serializer.normalizeQueryRecordResponse = function() {
      return {
        data: [{ id: 1, type: 'car' }],
      };
    };

    assert.expectAssertion(() => {
      run(() => store.queryRecord('car', {}));
    }, /Expected the primary data returned by the serializer for a 'queryRecord' response to be a single object or null but instead it was an array./);
  });

  test('The store should trap exceptions that are thrown from adapter#findRecord', function(assert) {
    assert.expect(1);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.findRecord = function() {
      throw new Error('Refusing to find record');
    };

    run(() => {
      store.findRecord('car', 1).catch(error => {
        assert.equal(error.message, 'Refusing to find record');
      });
    });
  });

  test('The store should trap exceptions that are thrown from adapter#findAll', function(assert) {
    assert.expect(1);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.findAll = function() {
      throw new Error('Refusing to find all records');
    };

    run(() => {
      store.findAll('car').catch(error => {
        assert.equal(error.message, 'Refusing to find all records');
      });
    });
  });

  test('The store should trap exceptions that are thrown from adapter#query', function(assert) {
    assert.expect(1);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.query = function() {
      throw new Error('Refusing to query records');
    };

    run(() => {
      store.query('car', {}).catch(error => {
        assert.equal(error.message, 'Refusing to query records');
      });
    });
  });

  test('The store should trap exceptions that are thrown from adapter#queryRecord', function(assert) {
    assert.expect(1);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.queryRecord = function() {
      throw new Error('Refusing to query record');
    };

    run(() => {
      store.queryRecord('car', {}).catch(error => {
        assert.equal(error.message, 'Refusing to query record');
      });
    });
  });

  test('The store should trap exceptions that are thrown from adapter#createRecord', function(assert) {
    assert.expect(1);

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.createRecord = function() {
      throw new Error('Refusing to serialize');
    };

    run(() => {
      let car = store.createRecord('car');

      car.save().catch(error => {
        assert.equal(error.message, 'Refusing to serialize');
      });
    });
  });
});

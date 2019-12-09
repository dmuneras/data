import { module, test } from 'qunit';
import { setupTest } from 'ember-qunit';
import testInDebug from '@ember-data/unpublished-test-infra/test-support/test-in-debug';
import RSVP from 'rsvp';

import Adapter from '@ember-data/adapter';
import JSONAPISerializer from '@ember-data/serializer/json-api';
import Model, { attr } from '@ember-data/model';
import { InvalidError } from '@ember-data/adapter/error';

module('integration/records/error', function(hooks) {
  setupTest(hooks);

  testInDebug('adding errors during root.loaded.created.invalid works', function(assert) {
    const Person = Model.extend({
      firstName: attr('string'),
      lastName: attr('string'),
    });

    this.owner.register('model:person', Person);
    this.owner.register('adapter:application', Adapter.extend());
    this.owner.register('serializer:application', JSONAPISerializer.extend());

    let store = this.owner.lookup('service:store');

    store.push({
      data: {
        type: 'person',
        id: 'wat',
        attributes: {
          firstName: 'Yehuda',
          lastName: 'Katz',
        },
      },
    });

    let person = store.peekRecord('person', 'wat');

    person.setProperties({
      firstName: null,
      lastName: null,
    });

    assert.equal(person._internalModel.currentState.stateName, 'root.loaded.updated.uncommitted');

    person.errors.add('firstName', 'is invalid');

    assert.equal(person._internalModel.currentState.stateName, 'root.loaded.updated.invalid');

    person.errors.add('lastName', 'is invalid');

    assert.deepEqual(person.errors.toArray(), [
      { attribute: 'firstName', message: 'is invalid' },
      { attribute: 'lastName', message: 'is invalid' },
    ]);
  });

  testInDebug('adding errors root.loaded.created.invalid works', function(assert) {
    const Person = Model.extend({
      firstName: attr('string'),
      lastName: attr('string'),
    });

    this.owner.register('model:person', Person);
    this.owner.register('adapter:application', Adapter.extend());
    this.owner.register('serializer:application', JSONAPISerializer.extend());

    let store = this.owner.lookup('service:store');

    let person = store.createRecord('person', {
      id: 'wat',
      firstName: 'Yehuda',
      lastName: 'Katz',
    });

    person.setProperties({
      firstName: null,
      lastName: null,
    });

    assert.equal(person._internalModel.currentState.stateName, 'root.loaded.created.uncommitted');

    person.errors.add('firstName', 'is invalid');

    assert.equal(person._internalModel.currentState.stateName, 'root.loaded.created.invalid');

    person.errors.add('lastName', 'is invalid');

    assert.deepEqual(person.errors.toArray(), [
      { attribute: 'firstName', message: 'is invalid' },
      { attribute: 'lastName', message: 'is invalid' },
    ]);
  });

  testInDebug('adding errors root.loaded.created.invalid works add + remove + add', function(assert) {
    const Person = Model.extend({
      firstName: attr('string'),
      lastName: attr('string'),
    });

    this.owner.register('model:person', Person);
    this.owner.register('adapter:application', Adapter.extend());
    this.owner.register('serializer:application', JSONAPISerializer.extend());

    let store = this.owner.lookup('service:store');

    let person = store.createRecord('person', {
      id: 'wat',
      firstName: 'Yehuda',
    });

    person.set('firstName', null);

    assert.equal(person._internalModel.currentState.stateName, 'root.loaded.created.uncommitted');

    person.errors.add('firstName', 'is invalid');

    assert.equal(person._internalModel.currentState.stateName, 'root.loaded.created.invalid');

    person.errors.remove('firstName');

    assert.deepEqual(person.errors.toArray(), []);

    person.errors.add('firstName', 'is invalid');

    assert.deepEqual(person.errors.toArray(), [{ attribute: 'firstName', message: 'is invalid' }]);
  });

  testInDebug('adding errors root.loaded.created.invalid works add + (remove, add)', function(assert) {
    const Person = Model.extend({
      firstName: attr('string'),
      lastName: attr('string'),
    });

    this.owner.register('model:person', Person);
    this.owner.register('adapter:application', Adapter.extend());
    this.owner.register('serializer:application', JSONAPISerializer.extend());

    let store = this.owner.lookup('service:store');

    let person = store.createRecord('person', {
      id: 'wat',
      firstName: 'Yehuda',
    });

    person.set('firstName', null);

    assert.equal(person._internalModel.currentState.stateName, 'root.loaded.created.uncommitted');

    person.errors.add('firstName', 'is invalid');

    assert.equal(person._internalModel.currentState.stateName, 'root.loaded.created.invalid');

    person.errors.remove('firstName');
    person.errors.add('firstName', 'is invalid');

    assert.equal(person._internalModel.currentState.stateName, 'root.loaded.created.invalid');

    assert.deepEqual(person.errors.toArray(), [{ attribute: 'firstName', message: 'is invalid' }]);
  });

  test('using setProperties to clear errors', async function(assert) {
    const Person = Model.extend({
      firstName: attr('string'),
      lastName: attr('string'),
    });

    this.owner.register('model:person', Person);
    this.owner.register('adapter:application', Adapter.extend());
    this.owner.register('serializer:application', JSONAPISerializer.extend());

    let store = this.owner.lookup('service:store');
    let adapter = store.adapterFor('application');

    adapter.reopen({
      createRecord() {
        return RSVP.reject(
          new InvalidError([
            {
              detail: 'Must be unique',
              source: { pointer: '/data/attributes/first-name' },
            },
            {
              detail: 'Must not be blank',
              source: { pointer: '/data/attributes/last-name' },
            },
          ])
        );
      },
    });

    let person = store.createRecord('person');

    try {
      person = await person.save();
    } catch (_error) {
      let errors = person.errors;

      assert.equal(errors.length, 2);
      assert.ok(errors.has('firstName'));
      assert.ok(errors.has('lastName'));

      person.setProperties({
        firstName: 'updated',
        lastName: 'updated',
      });

      assert.equal(errors.length, 0);
      assert.notOk(errors.has('firstName'));
      assert.notOk(errors.has('lastName'));
    }
  });
});

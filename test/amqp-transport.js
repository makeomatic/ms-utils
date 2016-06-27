/* eslint-disable no-console, max-len */

const chai = require('chai');
const expect = chai.expect;
const Errors = require('common-errors');
const Promise = require('bluebird');
const Proxy = require('amqp-coffee/test/proxy').route;
const ld = require('lodash');
const latency = time => {
  const execTime = process.hrtime(time);
  return execTime[0] * 1000 + (+(execTime[1] / 1000000).toFixed(3));
};

describe('AMQPTransport', function AMQPTransportTestSuite() {
  // require module
  const AMQPTransport = require('../src');
  const configuration = {
    exchange: 'test-exchange',
    connection: {
      host: process.env.RABBITMQ_PORT_5672_TCP_ADDR || 'localhost',
      port: process.env.RABBITMQ_PORT_5672_TCP_PORT || 5672,
    },
  };

  it('is able to be initialized', () => {
    const amqp = new AMQPTransport(configuration);
    expect(amqp).to.be.an.instanceof(AMQPTransport);
    expect(amqp).to.have.ownProperty('_config');
    expect(amqp).to.have.ownProperty('_replyQueue');
  });

  it('fails on invalid configuration', () => {
    function createTransport() {
      return new AMQPTransport({
        name: {},
        private: 'the-event',
        exchange: '',
        timeout: 'don-don',
        connection: 'bad option',
      });
    }

    expect(createTransport).to.throw(Errors.ValidationError);
  });

  it('is able to connect to rabbitmq', () => {
    const amqp = this.amqp = new AMQPTransport(configuration);
    return amqp.connect()
      .then(() => {
        expect(amqp._amqp.state).to.be.eq('open');
      });
  });

  it('is able to disconnect', () => (
    this.amqp.close().then(() => {
      expect(this.amqp._amqp).to.be.eq(null);
    })
  ));

  it('is able to connect via helper function', () => (
    AMQPTransport
      .connect(configuration)
      .then(amqp => {
        expect(amqp._amqp.state).to.be.eq('open');
        this.amqp = amqp;
      })
  ));

  it('is able to consume routes', () => {
    const opts = {
      exchange: configuration.exchange,
      queue: 'test-queue',
      listen: 'test.default',
      connection: configuration.connection,
    };

    return AMQPTransport
      .connect(opts, function listener(message, headers, actions, callback) {
        callback(null, { resp: `${message}-response`, time: process.hrtime() });
      })
      .then(amqp => {
        expect(amqp._amqp.state).to.be.eq('open');
        this.amqp_consumer = amqp;
      });
  });

  it('is able to publish to route consumer', () => {
    const sending = process.hrtime();
    return this.amqp.publishAndWait('test.default', 'test-message').then((response) => {
      expect(response.resp).to.be.eq('test-message-response');
      console.log(response.time);
      console.log('response sent and received after %s, total time %s', latency(response.time), latency(sending));
    });
  });

  it('is able to publish to route consumer:2', () => {
    const sending = process.hrtime();
    return this.amqp.publishAndWait('test.default', 'test-message').then((response) => {
      expect(response.resp).to.be.eq('test-message-response');
      console.log(response.time);
      console.log('response sent and received after %s, total time %s', latency(response.time), latency(sending));
    });
  });

  it('is able to publish to route consumer:2', () => {
    const sending = process.hrtime();
    return this.amqp.publishAndWait('test.default', 'test-message').then((response) => {
      expect(response.resp).to.be.eq('test-message-response');
      console.log(response.time);
      console.log('response sent and received after %s, total time %s', latency(response.time), latency(sending));
    });
  });

  it('is able to send messages directly to a queue', () => {
    const privateQueue = this.amqp._replyTo;
    return this.amqp_consumer
      .sendAndWait(privateQueue, 'test-message-direct-queue')
      .reflect()
      .then(promise => {
        expect(promise.isRejected()).to.be.eq(true);
        expect(promise.reason().name).to.be.eq('NotPermittedError');
      });
  });

  describe('concurrent publish', () => {
    before('init consumer', () => {
      const transport = this.concurrent = new AMQPTransport(configuration);
      return transport.connect();
    });

    it('able to publish multiple messages at once', () => {
      const transport = this.concurrent;
      const promises = ld.times(5, (i) => (
        transport.publishAndWait('test.default', `ok.${i}`)
      ));
      return Promise.all(promises);
    });

    after('close consumer', () => (
      this.concurrent.close()
    ));
  });

  describe('consumed queue', function test() {
    before('init transport', () => {
      this.proxy = new Proxy(9010, 5672, 'localhost');
      this.transport = new AMQPTransport({
        debug: true,
        connection: {
          port: 9010,
        },
        exchange: 'test-direct',
        exchangeArgs: {
          autoDelete: true,
          type: 'direct',
        },
        defaultQueueOpts: {
          autoDelete: true,
          exclusive: true,
        },
      });

      return this.transport.connect();
    });

    it('should create consumed queue', (done) => {
      const transport = this.transport;
      transport.on('consumed-queue-reconnected', (consumer, queue) => {
        // #2 reconnected, try publish
        transport
          .publishAndWait('/', { foo: 'bar' })
          .then(message => {
            // #4 OK, try unbind
            expect(message).to.be.deep.eq({ bar: 'baz' });
            return transport.unbindExchange(queue, '/');
          })
          .then(() => {
            // #5 unbinded, let's reconnect
            transport.removeAllListeners('consumed-queue-reconnected');
            transport.on('consumed-queue-reconnected', () => {
              // #7 reconnected again
              transport.publish('/', { bar: 'foo' });
              Promise.delay(1000).tap(done);
            });

            // #6 trigger error again
            setTimeout(() => {
              this.proxy.interrupt(20);
            }, 10);
          });
      });

      function router(message, headers, actions, next) {
        switch (headers.routingKey) {
          case '/':
            // #3 all right, try answer
            expect(message).to.be.deep.eq({ foo: 'bar' });
            return next(null, { bar: 'baz' });
          default:
            throw new Error();
        }
      }

      transport.createConsumedQueue(router)
        .spread((consumer, queue) => transport.bindExchange(queue, '/'))
        .tap(() => {
          // #1 trigger error
          setTimeout(() => {
            this.proxy.interrupt(20);
          }, 10);
        });
        // .catch((error) => { throw error; });
    });

    after('close transport', () => {
      this.proxy.close();
      this.transport.close();
    });
  });

  after('cleanup', () => (
    Promise.map(['amqp', 'amqp_consumer'], name => (
      this[name] && this[name].close()
    ))
  ));
});

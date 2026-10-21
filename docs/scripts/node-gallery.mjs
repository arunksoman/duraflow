// One small workflow per node type, loaded into the builder's DSL editor (never saved, so no
// worker starts) and photographed with that node's config panel open. `click` is the label of the
// node to select; the rest of the document is just enough context for the node to make sense.

const header = (type) => `document:
  dsl: 1.0.0
  taskQueue: docs-gallery
  workflowType: ${type}
  version: 0.1.0
`;

export const nodeGallery = [
  {
    name: 'node-start',
    click: 'Start',
    dsl: `${header('start-node')}input:
  schema:
    format: json
    document:
      type: object
      required:
        - customerId
      properties:
        customerId:
          type: string
        plan:
          type: string
do:
  - init:
      set:
        attempts: 0
        region: eu-west
  - welcome:
      set:
        message: \${ "Welcome " + $input.customerId }
`,
  },
  {
    name: 'node-rest',
    click: 'getCustomer',
    dsl: `${header('rest-node')}do:
  - getCustomer:
      call: http
      with:
        method: get
        endpoint: \${ "https://api.example.com/customers/" + $input.customerId }
        headers:
          Authorization: \${ "Bearer " + $env.API_TOKEN }
        query:
          expand: orders
      export:
        as: '\${ $context + { customer: . } }'
`,
  },
  {
    name: 'node-grpc',
    click: 'getQuote',
    dsl: `${header('grpc-node')}do:
  - getQuote:
      call: grpc
      with:
        proto:
          endpoint: https://example.com/protos/pricing.proto
        service:
          name: pricing.PricingService
          host: pricing.internal
          port: 50051
        method: GetQuote
        arguments:
          sku: \${ $input.sku }
`,
  },
  {
    name: 'node-set',
    click: 'prepare',
    dsl: `${header('set-node')}do:
  - prepare:
      set:
        orderId: \${ uuid }
        receivedAt: \${ timestamp_iso8601 }
        total: \${ $input.items | map(.price) | add }
`,
  },
  {
    name: 'node-switch',
    click: 'classify',
    dsl: `${header('switch-node')}do:
  - classify:
      switch:
        - electronic:
            when: \${ $input.orderType == "electronic" }
            then: processElectronicOrder
        - otherwise:
            then: end
  - confirm:
      set:
        confirmed: true
  - processElectronicOrder:
      do:
        - sendLicenceKey:
            set:
              licenceSent: true
`,
  },
  {
    name: 'node-for',
    click: 'eachItem',
    dsl: `${header('for-node')}do:
  - eachItem:
      for:
        each: item
        at: index
        in: \${ $input.items }
      while: \${ $data.index < 100 }
      do:
        - priceItem:
            set:
              price: \${ $data.item.price }
        - pause:
            wait:
              seconds: 1
`,
  },
  {
    name: 'node-fork',
    click: 'notify',
    dsl: `${header('fork-node')}do:
  - notify:
      fork:
        compete: false
        branches:
          - email:
              set:
                channel: email
          - sms:
              do:
                - render:
                    set:
                      body: Your order shipped
                - send:
                    set:
                      channel: sms
`,
  },
  {
    name: 'node-try',
    click: 'charge',
    dsl: `${header('try-node')}do:
  - charge:
      try:
        - capturePayment:
            call: http
            with:
              method: post
              endpoint: https://payments.example.com/capture
      catch:
        as: error
        do:
          - queuePayment:
              set:
                paymentQueued: true
`,
  },
  {
    name: 'node-wait',
    click: 'coolDown',
    dsl: `${header('wait-node')}do:
  - coolDown:
      wait:
        minutes: 5
        seconds: 30
`,
  },
  {
    name: 'node-listen',
    click: 'awaitApproval',
    dsl: `${header('listen-node')}do:
  - awaitApproval:
      listen:
        to:
          any:
            - with:
                id: approve
                type: signal
            - with:
                id: reject
                type: signal
`,
  },
  {
    name: 'node-raise',
    click: 'outOfStock',
    dsl: `${header('raise-node')}do:
  - outOfStock:
      raise:
        error:
          type: https://example.com/errors/out-of-stock
          status: 409
          title: Item out of stock
          detail: \${ "SKU " + $input.sku + " is unavailable" }
`,
  },
  {
    name: 'node-run',
    click: 'scoreRisk',
    dsl: `${header('run-node')}do:
  - scoreRisk:
      run:
        script:
          language: python
          code: |
            import json
            print(json.dumps({"score": 0.12}))
`,
  },
  {
    name: 'node-child',
    click: 'sendInvoice',
    dsl: `${header('child-node')}do:
  - sendInvoice:
      run:
        workflow:
          type: send-invoice
          input:
            value: \${ $input.orderId }
`,
  },
  {
    name: 'node-group',
    click: 'setup',
    dsl: `${header('group-node')}do:
  - setup:
      do:
        - loadConfig:
            set:
              retries: 3
        - warmCache:
            wait:
              seconds: 1
  - work:
      set:
        done: true
`,
  },
];

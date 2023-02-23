import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { GraphQLOrder } from '../object/Order';

export const OrderCollection = new GraphQLObjectType({
  name: 'OrderCollection',
  interfaces: [Collection],
  description: 'A collection of "Orders"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLOrder),
      },
    };
  },
});
